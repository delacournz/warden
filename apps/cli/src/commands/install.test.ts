import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WARDEN_RULE_LINE } from "../hooks/argent-rules";
import { type TestContext, testContext } from "../testing";
import { detectRuntime, type InstallDeps, runInstall } from "./install";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const ARGENT = "<device_selection_rule>\nDecision order:\n\n1. **Explicit user intent**\n</device_selection_rule>\n";

type Setup = { c: TestContext; home: string; deps: InstallDeps; questions: string[] };

function setup(argv: string[], overrides: Partial<InstallDeps> = {}): Setup {
	const c = testContext(argv);
	ctx = c;
	const home = join(c.cwd, "home");
	mkdirSync(home);
	c.env = { ...c.env, HOME: home };
	const binary = join(c.cwd, "warden-built");
	writeFileSync(binary, "#!/bin/sh\necho warden\n");
	const questions: string[] = [];
	const deps: InstallDeps = {
		runtime: { kind: "compiled", execPath: binary },
		interactive: true,
		confirm: async (q) => {
			questions.push(q);
			return true;
		},
		...overrides,
	};
	return { c, home, deps, questions };
}

const read = (path: string) => readFileSync(path, "utf8");
const claudeFile = (home: string, ...parts: string[]) => join(home, ".claude", ...parts);

function seedClaude(home: string, settings: unknown = { model: "opus" }) {
	mkdirSync(claudeFile(home, "rules"), { recursive: true });
	writeFileSync(claudeFile(home, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
	writeFileSync(claudeFile(home, "rules", "argent.md"), ARGENT);
}

describe("warden install", () => {
	test("copies the compiled binary to ~/.local/bin/warden (755), no claude files without --claude", async () => {
		const { c, home, deps } = setup([]);
		expect(await runInstall(c, deps)).toBe(0);
		const target = join(home, ".local", "bin", "warden");
		expect(read(target)).toBe("#!/bin/sh\necho warden\n");
		expect(statSync(target).mode & 0o777).toBe(0o755);
		expect(existsSync(join(home, ".claude"))).toBe(false);
	});

	test("second run → binary unchanged", async () => {
		const { c, deps } = setup(["--json"]);
		await runInstall(c, deps);
		c.stdout.length = 0;
		expect(await runInstall(c, deps)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n")).steps[0]).toMatchObject({ step: "binary", status: "unchanged" });
	});

	test("dev mode: prints build instructions, or writes a shim with --shim", async () => {
		const { c, home, deps } = setup(["--json"], { runtime: { kind: "dev", cliPath: "/repo/apps/cli/src/cli.ts" } });
		expect(await runInstall(c, deps)).toBe(0);
		const step = JSON.parse(c.stdout.join("\n")).steps[0];
		expect(step).toMatchObject({ step: "binary", status: "skipped" });
		expect(step.detail).toContain("bun run --cwd /repo/apps/cli build");
		c.argv = ["--shim"];
		expect(await runInstall(c, deps)).toBe(0);
		const shim = join(home, ".local", "bin", "warden");
		expect(read(shim)).toBe('#!/bin/sh\nexec bun "/repo/apps/cli/src/cli.ts" "$@"\n');
		expect(statSync(shim).mode & 0o777).toBe(0o755);
	});

	test("--claude writes skill, merges hooks, patches argent rules after confirming", async () => {
		const { c, home, deps, questions } = setup(["--claude"]);
		seedClaude(home);
		expect(await runInstall(c, deps)).toBe(0);
		expect(read(claudeFile(home, "skills", "warden", "SKILL.md"))).toStartWith("---\nname: warden\n");
		const settings = JSON.parse(read(claudeFile(home, "settings.json")));
		expect(settings.model).toBe("opus");
		expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("$HOME/.local/bin/warden hook pretool");
		expect(read(claudeFile(home, "rules", "argent.md"))).toContain(WARDEN_RULE_LINE);
		expect(questions).toHaveLength(2);
		const out = c.stdout.join("\n");
		expect(out).toContain("+ ");
		expect(out).toContain("hook pretool");
	});

	test("--claude is idempotent", async () => {
		const { c, home, deps, questions } = setup(["--claude"]);
		seedClaude(home);
		await runInstall(c, deps);
		const settings = read(claudeFile(home, "settings.json"));
		const rules = read(claudeFile(home, "rules", "argent.md"));
		questions.length = 0;
		c.argv = ["--claude", "--json"];
		c.stdout.length = 0;
		expect(await runInstall(c, deps)).toBe(0);
		expect(questions).toEqual([]);
		expect(read(claudeFile(home, "settings.json"))).toBe(settings);
		expect(read(claudeFile(home, "rules", "argent.md"))).toBe(rules);
		const statuses = JSON.parse(c.stdout.join("\n")).steps.map((s: { status: string }) => s.status);
		expect(statuses).toEqual(["unchanged", "unchanged", "unchanged", "unchanged"]);
	});

	test("declined confirmation leaves settings + rules untouched", async () => {
		const { c, home, deps } = setup(["--claude", "--json"], { confirm: async () => false });
		seedClaude(home);
		expect(await runInstall(c, deps)).toBe(0);
		expect(JSON.parse(read(claudeFile(home, "settings.json")))).toEqual({ model: "opus" });
		expect(read(claudeFile(home, "rules", "argent.md"))).toBe(ARGENT);
		const steps = JSON.parse(c.stdout.join("\n")).steps;
		expect(steps.map((s: { status: string }) => s.status)).toEqual(["written", "written", "declined", "declined"]);
	});

	test("non-interactive without --yes → skip guarded steps; --yes writes without asking", async () => {
		const { c, home, deps, questions } = setup(["--claude", "--json"], { interactive: false });
		seedClaude(home);
		expect(await runInstall(c, deps)).toBe(0);
		expect(JSON.parse(read(claudeFile(home, "settings.json")))).toEqual({ model: "opus" });
		const skipped = JSON.parse(c.stdout.join("\n")).steps[2];
		expect(skipped).toMatchObject({ step: "settings", status: "skipped" });
		expect(skipped.detail).toContain("--yes");
		c.argv = ["--claude", "--yes"];
		expect(await runInstall(c, deps)).toBe(0);
		expect(questions).toEqual([]);
		expect(JSON.parse(read(claudeFile(home, "settings.json"))).hooks.SessionEnd).toHaveLength(1);
	});

	test("--dry-run writes nothing but prints diffs", async () => {
		const { c, home, deps, questions } = setup(["--claude", "--dry-run"]);
		seedClaude(home);
		expect(await runInstall(c, deps)).toBe(0);
		expect(existsSync(join(home, ".local"))).toBe(false);
		expect(existsSync(claudeFile(home, "skills"))).toBe(false);
		expect(JSON.parse(read(claudeFile(home, "settings.json")))).toEqual({ model: "opus" });
		expect(questions).toEqual([]);
		expect(c.stdout.join("\n")).toContain(`+ ${WARDEN_RULE_LINE}`);
	});

	test("missing settings.json is created; missing argent.md is skipped", async () => {
		const { c, home, deps } = setup(["--claude", "--yes", "--json"]);
		expect(await runInstall(c, deps)).toBe(0);
		expect(JSON.parse(read(claudeFile(home, "settings.json"))).hooks.PreToolUse).toHaveLength(1);
		const steps = JSON.parse(c.stdout.join("\n")).steps;
		expect(steps[3]).toMatchObject({ step: "argent-rules", status: "skipped" });
	});

	test("invalid settings.json → error step, file untouched, exit 1", async () => {
		const { c, home, deps } = setup(["--claude", "--yes", "--json"]);
		seedClaude(home);
		writeFileSync(claudeFile(home, "settings.json"), "{ nope");
		expect(await runInstall(c, deps)).toBe(1);
		expect(read(claudeFile(home, "settings.json"))).toBe("{ nope");
		expect(JSON.parse(c.stdout.join("\n")).steps[2]).toMatchObject({ step: "settings", status: "error" });
	});

	test("keeps tab indentation of an existing settings.json", async () => {
		const { c, home, deps } = setup(["--claude", "--yes"]);
		seedClaude(home);
		writeFileSync(claudeFile(home, "settings.json"), '{\n\t"model": "opus"\n}\n');
		await runInstall(c, deps);
		expect(read(claudeFile(home, "settings.json"))).toStartWith('{\n\t"model": "opus",\n\t"hooks"');
	});

	test("no HOME → exit 1", async () => {
		const { c, deps } = setup([]);
		c.env = { ...c.env, HOME: undefined };
		expect(await runInstall(c, deps)).toBe(1);
	});
});

describe("detectRuntime", () => {
	test("bun-compiled entry → compiled; otherwise dev", () => {
		expect(detectRuntime("/$bunfs/root/warden", "/usr/local/bin/warden")).toEqual({
			kind: "compiled",
			execPath: "/usr/local/bin/warden",
		});
		expect(detectRuntime("/repo/apps/cli/src/cli.ts", "/opt/bun")).toEqual({
			kind: "dev",
			cliPath: "/repo/apps/cli/src/cli.ts",
		});
	});
});
