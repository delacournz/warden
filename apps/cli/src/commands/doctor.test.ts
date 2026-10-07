import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS } from "@delacour/warden-core/store";
import { Chalk } from "chalk";
import { mergeClaudeSettings } from "../hooks/claude-settings";
import { mergeCodexHooks } from "../hooks/codex-hooks";
import { fakeExec, scriptedUi, type TestContext, testContext } from "../testing";
import { type DoctorCheck, doctorCommand, installProbe } from "./doctor";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const ALL_TOOLS = fakeExec([
	["xcrun simctl help", {}],
	["adb version", { stdout: "Android Debug Bridge version 1.0.41" }],
	["emulator -version", { stdout: "Android emulator version 35.1" }],
	["ccache --version", { stdout: "ccache version 4.10" }],
]);

function setup(argv: string[], exec = ALL_TOOLS): TestContext {
	ctx = testContext(argv, { exec });
	ctx.env = { ...ctx.env, PATH: "/usr/bin" };
	return ctx;
}

function checks(c: TestContext): DoctorCheck[] {
	return JSON.parse(c.stdout.join("\n")).checks;
}

function byName(c: TestContext): Record<string, DoctorCheck> {
	return Object.fromEntries(checks(c).map((x) => [x.name, x]));
}

function installEverything(home: string, env: TestContext["env"]): TestContext["env"] {
	const bin = join(home, ".local", "bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "warden"), "#!/bin/sh\n");
	chmodSync(join(bin, "warden"), 0o755);
	mkdirSync(join(home, ".claude", "skills", "warden"), { recursive: true });
	writeFileSync(join(home, ".claude", "skills", "warden", "SKILL.md"), "---\nname: warden\n---\n");
	const merged = mergeClaudeSettings({}, "$HOME/.local/bin/warden");
	if (!merged.success) throw new Error(merged.error);
	writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(merged.data.settings));
	return { ...env, PATH: `/usr/bin:${bin}` };
}

describe("warden doctor", () => {
	test("fresh machine: core ok, integrations warn, exit 0", async () => {
		const c = setup(["--json"]);
		expect(await doctorCommand.run(c)).toBe(0);
		const r = byName(c);
		expect(r.home?.status).toBe("ok");
		expect(r.db).toMatchObject({ status: "ok", level: "core" });
		expect(r.db?.detail).toContain(`schema v${MIGRATIONS.length}`);
		expect(r.simctl?.status).toBe("ok");
		expect(r.adb?.status).toBe("ok");
		expect(r.emulator?.status).toBe("ok");
		expect(r.path).toMatchObject({ status: "warn", level: "optional" });
		expect(r["claude-hook"]?.status).toBe("warn");
		expect(r.skill?.status).toBe("warn");
		expect(r["stale-leases"]?.status).toBe("ok");
		expect(JSON.parse(c.stdout.join("\n")).ok).toBe(true);
	});

	test("everything installed → all ok", async () => {
		const c = setup(["--json"]);
		c.env = installEverything(c.cwd, c.env);
		expect(await doctorCommand.run(c)).toBe(0);
		expect(checks(c).filter((x) => x.status !== "ok")).toEqual([]);
	});

	test("install: always reported, ok", async () => {
		const c = setup(["--json"]);
		await doctorCommand.run(c);
		expect(byName(c).install).toMatchObject({ status: "ok", level: "optional" });
	});

	test("path: ~/.local/bin off PATH but `warden` resolves elsewhere (npm global bin) → ok", async () => {
		const c = setup(["--json"]);
		c.env = installEverything(c.cwd, c.env);
		const npmBin = join(c.cwd, "npm-prefix", "bin");
		mkdirSync(npmBin, { recursive: true });
		writeFileSync(join(npmBin, "warden"), "#!/bin/sh\n");
		chmodSync(join(npmBin, "warden"), 0o755);
		c.env = { ...c.env, PATH: `/usr/bin:${npmBin}` };
		await doctorCommand.run(c);
		expect(byName(c).path?.status).toBe("ok");
		expect(byName(c).path?.detail).toContain(join(npmBin, "warden"));
	});

	test("codex-hook: not detected → ok; detected without hooks → warn; installed → ok", async () => {
		const c = setup(["--json"]);
		await doctorCommand.run(c);
		expect(byName(c)["codex-hook"]).toMatchObject({ status: "ok", detail: "codex not detected" });
		const codexDir = join(c.cwd, ".codex");
		mkdirSync(codexDir, { recursive: true });
		c.stdout.length = 0;
		await doctorCommand.run(c);
		expect(byName(c)["codex-hook"]?.status).toBe("warn");
		expect(byName(c)["codex-hook"]?.detail).toContain("warden install --codex");
		const merged = mergeCodexHooks(undefined, "$HOME/.local/bin/warden");
		if (!merged.success) throw new Error(merged.error);
		writeFileSync(join(codexDir, "hooks.json"), JSON.stringify(merged.data.settings));
		c.stdout.length = 0;
		await doctorCommand.run(c);
		expect(byName(c)["codex-hook"]).toMatchObject({ status: "ok", detail: join(codexDir, "hooks.json") });
	});

	test("ccache: missing → warn; Podfile.properties checks", async () => {
		const c = setup(["--json"], fakeExec([]));
		await doctorCommand.run(c);
		expect(byName(c).ccache?.status).toBe("warn");
		expect(byName(c).ccache?.detail).toContain("brew install ccache");
		expect(byName(c)["ccache-project"]?.status).toBe("ok");

		const iosDir = join(c.cwd, "ios");
		mkdirSync(iosDir, { recursive: true });
		const props = join(iosDir, "Podfile.properties.json");
		writeFileSync(props, JSON.stringify({ "ios.buildReactNativeFromSource": "true" }));
		c.stdout.length = 0;
		await doctorCommand.run(c);
		const warn = byName(c)["ccache-project"];
		expect(warn?.status).toBe("warn");
		expect(warn?.detail).toContain("ios.ccacheEnabled: true");
		expect(warn?.detail).toContain("buildReactNativeFromSource");

		writeFileSync(props, JSON.stringify({ "apple.ccacheEnabled": "true" }));
		c.stdout.length = 0;
		await doctorCommand.run(c);
		expect(byName(c)["ccache-project"]?.status).toBe("ok");
	});

	test("missing device tools only warn", async () => {
		const c = setup(["--json"], fakeExec([]));
		expect(await doctorCommand.run(c)).toBe(0);
		const r = byName(c);
		expect(r.simctl?.status).toBe("warn");
		expect(r.adb?.status).toBe("warn");
	});

	test("android tools resolve via ANDROID_HOME", async () => {
		const calls: string[][] = [];
		const c = setup(["--json"], fakeExec([["", {}]], calls));
		c.env = { ...c.env, ANDROID_HOME: "/sdk" };
		await doctorCommand.run(c);
		expect(calls.map((x) => x[0])).toContain("/sdk/platform-tools/adb");
		expect(calls.map((x) => x[0])).toContain("/sdk/emulator/emulator");
	});

	test("stale leases are counted", async () => {
		const c = setup(["--json"]);
		c.db.insertLease(
			{ resource: { kind: "port", port: 1 }, owner: { kind: "agent", sessionId: "x", cwd: "/" }, ttlMs: 1 },
			c.now() - 10_000
		);
		await doctorCommand.run(c);
		expect(byName(c)["stale-leases"]).toMatchObject({ status: "warn", detail: "1 stale lease — run `warden gc`" });
	});

	test("unwritable warden home → core failure, exit 1", async () => {
		const c = setup([]);
		const file = join(c.cwd, "not-a-dir");
		writeFileSync(file, "");
		c.env = { ...c.env, WARDEN_HOME: join(file, "sub") };
		expect(await doctorCommand.run(c)).toBe(1);
		expect(c.stdout.join("\n")).toContain("✗ home");
	});

	test("human output uses ✓ / ! marks", async () => {
		const c = setup([]);
		expect(await doctorCommand.run(c)).toBe(0);
		const out = c.stdout.join("\n");
		expect(out).toContain("✓ db");
		expect(out).toContain("! skill");
	});

	test("colour: ✓ green, ! yellow, ✗ red; --json stays plain", async () => {
		const c = setup([]);
		c.ui = { ...scriptedUi(), color: new Chalk({ level: 1 }) };
		const file = join(c.cwd, "not-a-dir");
		writeFileSync(file, "");
		c.env = { ...c.env, WARDEN_HOME: join(file, "sub") };
		await doctorCommand.run(c);
		const out = c.stdout.join("\n");
		expect(out).toContain("\u001b[32m✓\u001b[39m db");
		expect(out).toContain("\u001b[33m!\u001b[39m skill");
		expect(out).toContain("\u001b[31m✗\u001b[39m home");
		c.cleanup();
		const d = setup(["--json"]);
		d.ui = { ...scriptedUi(), color: new Chalk({ level: 1 }) };
		await doctorCommand.run(d);
		expect(d.stdout.join("\n")).not.toContain("\u001b[");
	});

	test("unknown option → commander usage error, exit 1", async () => {
		const c = setup(["--bogus"]);
		expect(await doctorCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("unknown option '--bogus'");
		expect(c.stdout).toEqual([]);
	});
});

describe("installProbe", () => {
	test("npm global install → names it and the npm upgrade command", () => {
		const probe = installProbe(
			{ channel: "release", version: "0.3.0" },
			"/usr/local/lib/node_modules/@delacour/warden/node_modules/@delacour/warden-linux-x64/bin/warden"
		);
		expect(probe.ok).toBe(true);
		expect(probe.detail).toContain("npm global install of @delacour/warden");
		expect(probe.detail).toContain("npm i -g @delacour/warden@latest");
	});

	test("a copy from npx / bunx → updates from npm", () => {
		expect(installProbe({ channel: "release", version: "0.3.0" }, "/h/.local/bin/warden", "npm").detail).toBe(
			"release binary /h/.local/bin/warden (from npm) — `warden update` upgrades it from @delacour/warden on npm"
		);
	});

	test("standalone builds → channel + `warden update`", () => {
		expect(installProbe({ channel: "release", version: "0.3.0" }, "/h/.local/bin/warden").detail).toBe(
			"release binary /h/.local/bin/warden — `warden update` upgrades it"
		);
		expect(installProbe({ channel: "dev", version: "0.3.0", sourceDir: "/repo" }, "/bin/bun").detail).toBe(
			"running from source /repo — `warden update` builds ~/.local/bin/warden"
		);
	});
});
