import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASH_GATE, defaultPackageRootOf, KITS_DIR, type KitDeps, resolveKit, TOOL_IDS } from "./kit";
import { createSandbox } from "./sandbox";

/** the CLI version the vendored agent-device skills match (`kits/agent-device/SOURCE.json`) */
const VENDORED = String(JSON.parse(readFileSync(join(KITS_DIR, "agent-device", "SOURCE.json"), "utf8")).tag).slice(1);

function fakeRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "agent-bench-kit-"));
	mkdirSync(join(root, "skills", "warden", "rules"), { recursive: true });
	writeFileSync(join(root, "skills", "warden", "SKILL.md"), "skill");
	writeFileSync(join(root, "skills", "warden", "rules", "warden.md"), "rule");
	mkdirSync(join(root, "apps", "cli"), { recursive: true });
	writeFileSync(join(root, "apps", "cli", "package.json"), JSON.stringify({ version: "0.20.0" }));
	return root;
}

/** A global install the way bun lays one out: `<pkg>/package.json`, `<pkg>/skills/*`, `<pkg>/rules/*.md`. */
function fakeArgent(): string {
	const pkg = mkdtempSync(join(tmpdir(), "agent-bench-argent-"));
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@swmansion/argent", version: "0.27.0" }));
	mkdirSync(join(pkg, "skills", "argent-device-interact"), { recursive: true });
	writeFileSync(join(pkg, "skills", "argent-device-interact", "SKILL.md"), "argent skill");
	mkdirSync(join(pkg, "rules"), { recursive: true });
	writeFileSync(join(pkg, "rules", "argent.md"), "argent rule");
	return pkg;
}

function deps(installed: Record<string, string>, packageRoots: Record<string, string> = {}): KitDeps {
	return {
		which: (cmd) => installed[cmd],
		packageRootOf: (bin) => packageRoots[bin],
		readText: (p) => (existsSync(p) ? readFileSync(p, "utf8") : undefined),
		exists: existsSync,
		env: {},
		home: () => "/home/u",
	};
}

const INPUT = (repoRoot: string) => ({ repoRoot, bunPath: "/b/bun", cliPath: join(repoRoot, "apps/cli/src/cli.ts") });

describe("resolveKit: warden", () => {
	test("the checkout's skill and rule, a CLI shim, Bash(warden *)", () => {
		const repo = fakeRepo();
		const kit = resolveKit("warden", INPUT(repo), deps({}));
		if (!kit.success) throw new Error(String(kit.error));
		expect(kit.data.version).toBe("0.20.0");
		expect(kit.data.allowedTools).toContain("Bash(warden *)");
		expect(kit.data.driver).toEqual({ kind: "cli", bin: "warden", groups: ["ui"] });
		expect(kit.data.failurePatterns).toContain("stale_ref");
		expect(kit.data.shims).toEqual([{ name: "warden", argv: ["/b/bun", join(repo, "apps/cli/src/cli.ts")] }]);
		expect(kit.data.preamble).toContain("`--udid {{udid}}`");
		expect(kit.data.bashGate).toEqual(["/b/bun", BASH_GATE, "warden"]);
		expect(existsSync(BASH_GATE)).toBe(true);
	});

	test("a missing skill is unavailable", () => {
		expect(resolveKit("warden", INPUT("/nope"), deps({})).success).toBe(false);
	});
});

describe("resolveKit: argent", () => {
	test("the installed package's skills and rule, and only the argent MCP server", () => {
		const pkg = fakeArgent();
		const bin = "/g/bin/argent";
		const kit = resolveKit("argent", INPUT(fakeRepo()), deps({ argent: bin }, { [bin]: pkg }));
		if (!kit.success) throw new Error(String(kit.error));
		expect(kit.data.version).toBe("0.27.0");
		expect(kit.data.mcpServers).toEqual({ argent: { command: bin, args: ["mcp"] } });
		expect(kit.data.allowedTools).toEqual(["mcp__argent", "Skill", "Read"]);
		expect(kit.data.driver).toEqual({ kind: "mcp", server: "argent" });
		expect(kit.data.bashGate).toBeUndefined();
		const sb = createSandbox(mkdtempSync(join(tmpdir(), "agent-bench-sb-")), kit.data);
		expect(readFileSync(join(sb.configDir, "skills", "argent-device-interact", "SKILL.md"), "utf8")).toBe(
			"argent skill"
		);
		expect(readFileSync(join(sb.configDir, "rules", "argent.md"), "utf8")).toBe("argent rule");
		expect(existsSync(join(sb.configDir, "agents"))).toBe(false);
	});

	test("not on PATH is unavailable with the install hint", () => {
		const kit = resolveKit("argent", INPUT(fakeRepo()), deps({}));
		expect(kit.success).toBe(false);
		if (!kit.success) expect(String(kit.error)).toContain("bun add -g @swmansion/argent");
	});
});

describe("resolveKit: agent-device", () => {
	test("the vendored skills and rule, the CLI on PATH, the bench's private state dir", () => {
		const pkg = mkdtempSync(join(tmpdir(), "agent-bench-ad-"));
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: VENDORED }));
		const bin = "/g/bin/agent-device";
		const kit = resolveKit("agent-device", INPUT(fakeRepo()), deps({ "agent-device": bin }, { [bin]: pkg }));
		if (!kit.success) throw new Error(String(kit.error));
		expect(kit.data.version).toBe(VENDORED);
		expect(kit.data.allowedTools).toContain("Bash(agent-device *)");
		expect(kit.data.env.AGENT_DEVICE_STATE_DIR).toBe("/home/u/.agent-device-bench/agent-device");
		expect(kit.data.driver).toEqual({ kind: "cli", bin: "agent-device", groups: [] });
		expect(kit.data.preamble).toContain("`{{deviceFlag}} {{udid}}`");
		expect(kit.data.bashGate).toEqual(["/b/bun", BASH_GATE, "agent-device"]);
		expect(kit.data.notes.join(" ")).not.toContain("refresh kits/agent-device");
	});

	test("a CLI newer than the vendored skills is noted", () => {
		const pkg = mkdtempSync(join(tmpdir(), "agent-bench-ad-"));
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: "0.30.0" }));
		const bin = "/g/bin/agent-device";
		const kit = resolveKit("agent-device", INPUT(fakeRepo()), deps({ "agent-device": bin }, { [bin]: pkg }));
		if (!kit.success) throw new Error(String(kit.error));
		expect(kit.data.notes.join(" ")).toContain("refresh kits/agent-device");
	});
});

describe("the committed agent-device kit", () => {
	test("vendors every skill the repo ships, the rule and the source pin", () => {
		const dir = join(KITS_DIR, "agent-device");
		expect(readdirSync(join(dir, "skills")).sort()).toEqual([
			"agent-device",
			"android-emulator",
			"dogfood",
			"ios-simulator",
		]);
		expect(readFileSync(join(dir, "skills", "agent-device", "SKILL.md"), "utf8")).toContain("name: agent-device");
		expect(readFileSync(join(dir, "rules", "agent-device.md"), "utf8")).toContain("Use agent-device only");
		expect(JSON.parse(readFileSync(join(dir, "SOURCE.json"), "utf8")).tag).toMatch(/^v\d+\.\d+\.\d+$/);
	});
});

describe("defaultPackageRootOf", () => {
	test("walks up from a bin to its package.json", () => {
		const pkg = mkdtempSync(join(tmpdir(), "agent-bench-pkg-"));
		writeFileSync(join(pkg, "package.json"), "{}");
		mkdirSync(join(pkg, "dist"), { recursive: true });
		writeFileSync(join(pkg, "dist", "cli.js"), "");
		expect(defaultPackageRootOf(join(pkg, "dist", "cli.js"))).toBe(defaultPackageRootOf(join(pkg, "package.json")));
		expect(defaultPackageRootOf("/definitely/not/here")).toBeUndefined();
	});
});

test("TOOL_IDS run warden first", () => {
	expect(TOOL_IDS[0]).toBe("warden");
});
