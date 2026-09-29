import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS } from "@warden/core/store";
import { mergeClaudeSettings } from "../hooks/claude-settings";
import { mergeCodexHooks } from "../hooks/codex-hooks";
import { fakeExec, type TestContext, testContext } from "../testing";
import { type DoctorCheck, doctorCommand } from "./doctor";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const ALL_TOOLS = fakeExec([
	["xcrun simctl help", {}],
	["adb version", { stdout: "Android Debug Bridge version 1.0.41" }],
	["emulator -version", { stdout: "Android emulator version 35.1" }],
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
});
