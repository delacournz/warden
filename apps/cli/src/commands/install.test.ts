import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Chalk } from "chalk";
import { RULE_MD, SKILL_FILES, SKILL_PATHS } from "../skill";
import { type ScriptedUi, scriptedUi, type TestContext, testContext } from "../testing";
import { installOrigin } from "../update/install-origin";
import { createInstallCommand, detectRuntime, type InstallDeps, legacyRules, type Runtime } from "./install";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

type Setup = {
	c: TestContext;
	home: string;
	deps: InstallDeps;
	questions: string[];
	ui: ScriptedUi;
	/** argv of every skills CLI invocation */
	runs: string[][];
	/** the RunOpts each skills CLI invocation got */
	runOpts: Array<{ stdout: string } | undefined>;
};

type SetupOpts = {
	runtime?: Runtime;
	interactive?: boolean;
	/** scripted confirm answers (undefined = cancelled); default: yes to everything */
	confirm?: Array<boolean | undefined>;
	/** `which` results for the skills runner (default: bunx and npx present) */
	which?: Record<string, string>;
	/** exit code of the fake skills CLI (default 0) */
	skillExit?: number;
};

function setup(argv: string[], opts: SetupOpts = {}): Setup {
	const c = testContext(argv);
	ctx = c;
	const home = join(c.cwd, "home");
	mkdirSync(home);
	c.env = { ...c.env, HOME: home };
	const binary = join(c.cwd, "warden-built");
	writeFileSync(binary, "#!/bin/sh\necho warden\n");
	const ui = scriptedUi({ interactive: opts.interactive ?? true, confirm: opts.confirm ?? Array(8).fill(true) });
	const questions: string[] = [];
	const ask = ui.confirm;
	ui.confirm = async (question, initial) => {
		questions.push(question);
		return ask(question, initial);
	};
	c.ui = ui;
	const which = opts.which ?? { bunx: "/opt/bun/bin/bunx", npx: "/usr/bin/npx" };
	const runs: string[][] = [];
	const runOpts: Array<{ stdout: string } | undefined> = [];
	const deps: InstallDeps = {
		runtime: opts.runtime ?? { kind: "compiled", execPath: binary },
		skill: {
			which: (cmd) => which[cmd] ?? null,
			runInteractive: async (cmd, runOptions) => {
				runs.push(cmd);
				runOpts.push(runOptions);
				const code = opts.skillExit ?? 0;
				const source = cmd[cmd.indexOf("add") + 1];
				// the real skills CLI places the staged skill under ~/.claude/skills; do the same
				if (code === 0 && source)
					cpSync(join(source, "warden"), join(home, ".claude", "skills", "warden"), { recursive: true });
				return code;
			},
		},
	};
	return { c, home, deps, questions, ui, runs, runOpts };
}

const runInstall = (c: TestContext, deps: InstallDeps) => createInstallCommand(() => deps).run(c);

const read = (path: string) => readFileSync(path, "utf8");
const claudeFile = (home: string, ...parts: string[]) => join(home, ".claude", ...parts);
const codexFile = (home: string, ...parts: string[]) => join(home, ".codex", ...parts);

function seedClaude(home: string, settings: unknown = { model: "opus" }) {
	mkdirSync(claudeFile(home), { recursive: true });
	writeFileSync(claudeFile(home, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

describe("warden install", () => {
	test("copies the compiled binary to ~/.local/bin/warden (755); no agent detected → no agent files", async () => {
		const { c, home, deps } = setup([]);
		expect(await runInstall(c, deps)).toBe(0);
		const target = join(home, ".local", "bin", "warden");
		expect(read(target)).toBe("#!/bin/sh\necho warden\n");
		expect(statSync(target).mode & 0o777).toBe(0o755);
		expect(existsSync(join(home, ".claude"))).toBe(false);
		expect(existsSync(join(home, ".codex"))).toBe(false);
		expect(c.stdout.join("\n")).toContain("no Claude Code or Codex detected");
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

	test("npm global install: links ~/.local/bin/warden to the package's binary so upgrades follow npm", async () => {
		const execPath =
			"/usr/local/lib/node_modules/@delacour/warden/node_modules/@delacour/warden-darwin-arm64/bin/warden";
		const { c, home, deps } = setup(["--json"], { runtime: { kind: "compiled", execPath } });
		expect(await runInstall(c, deps)).toBe(0);
		const shim = join(home, ".local", "bin", "warden");
		expect(read(shim)).toBe(`#!/bin/sh\nexec "${execPath}" "$@"\n`);
		expect(statSync(shim).mode & 0o777).toBe(0o755);
		const step = JSON.parse(c.stdout.join("\n")).steps[0];
		expect(step).toMatchObject({ step: "binary", status: "written" });
		expect(step.detail).toContain("npm global install");
		c.stdout.length = 0;
		expect(await runInstall(c, deps)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n")).steps[0]).toMatchObject({ step: "binary", status: "unchanged" });
	});

	test("npx run: copies the cached binary (the cache isn't a stable path) and says how to refresh it", async () => {
		const { c, home, deps } = setup(["--json"]);
		const cache = join(c.cwd, ".npm", "_npx", "ab12", "node_modules", "@delacour", "warden-darwin-arm64", "bin");
		mkdirSync(cache, { recursive: true });
		const execPath = join(cache, "warden");
		writeFileSync(execPath, "NPX-BINARY");
		deps.runtime = { kind: "compiled", execPath };
		expect(await runInstall(c, deps)).toBe(0);
		expect(read(join(home, ".local", "bin", "warden"))).toBe("NPX-BINARY");
		const step = JSON.parse(c.stdout.join("\n")).steps[0];
		expect(step.detail).toContain("npx @delacour/warden@latest install");
		const target = join(home, ".local", "bin", "warden");
		expect(installOrigin(c.env, target)).toBe("npm");
		deps.runtime = { kind: "compiled", execPath: join(c.cwd, "warden-built") };
		c.stdout.length = 0;
		expect(await runInstall(c, deps)).toBe(0);
		expect(installOrigin(c.env, target)).toBeUndefined();
	});

	test("--claude writes skill and merges the SessionEnd hook after confirming", async () => {
		const { c, home, deps, questions } = setup(["--claude"]);
		seedClaude(home);
		expect(await runInstall(c, deps)).toBe(0);
		expect(read(claudeFile(home, "skills", "warden", "SKILL.md"))).toStartWith("---\nname: warden\n");
		const settings = JSON.parse(read(claudeFile(home, "settings.json")));
		expect(settings.model).toBe("opus");
		expect(settings.hooks.PreToolUse).toBeUndefined();
		expect(settings.hooks.SessionEnd[0].hooks[0].command).toBe("$HOME/.local/bin/warden hook session-end");
		expect(questions).toHaveLength(1);
		const out = c.stdout.join("\n");
		expect(out).toContain("+ ");
		expect(out).toContain("hook session-end");
	});

	test("--claude is idempotent", async () => {
		const { c, home, deps, questions } = setup(["--claude"]);
		seedClaude(home);
		await runInstall(c, deps);
		const settings = read(claudeFile(home, "settings.json"));
		questions.length = 0;
		c.argv = ["--claude", "--json"];
		c.stdout.length = 0;
		expect(await runInstall(c, deps)).toBe(0);
		expect(questions).toEqual([]);
		expect(read(claudeFile(home, "settings.json"))).toBe(settings);
		const statuses = JSON.parse(c.stdout.join("\n")).steps.map((s: { status: string }) => s.status);
		expect(statuses).toEqual(["unchanged", "unchanged", "unchanged", "unchanged"]);
	});

	test("declined confirmation leaves settings untouched", async () => {
		const { c, home, deps } = setup(["--claude", "--json"], { confirm: [false] });
		seedClaude(home);
		expect(await runInstall(c, deps)).toBe(0);
		expect(JSON.parse(read(claudeFile(home, "settings.json")))).toEqual({ model: "opus" });
		const steps = JSON.parse(c.stdout.join("\n")).steps;
		expect(steps.map((s: { status: string }) => s.status)).toEqual(["written", "written", "written", "declined"]);
	});

	test("non-interactive without --yes → skip guarded steps; --yes writes without asking", async () => {
		const { c, home, deps, questions } = setup(["--claude", "--json"], { interactive: false });
		seedClaude(home);
		expect(await runInstall(c, deps)).toBe(0);
		expect(JSON.parse(read(claudeFile(home, "settings.json")))).toEqual({ model: "opus" });
		const skipped = JSON.parse(c.stdout.join("\n")).steps[3];
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
		expect(c.stdout.join("\n")).toContain("hook session-end");
	});

	test("missing settings.json is created", async () => {
		const { c, home, deps } = setup(["--claude", "--yes", "--json"]);
		expect(await runInstall(c, deps)).toBe(0);
		expect(JSON.parse(read(claudeFile(home, "settings.json"))).hooks.SessionEnd).toHaveLength(1);
		const steps = JSON.parse(c.stdout.join("\n")).steps;
		expect(steps.map((x: { step: string }) => x.step)).toEqual(["binary", "skill", "rule", "settings"]);
	});

	test("hooks an older warden installed (the PreToolUse matcher) are removed, other hooks stay", async () => {
		const { c, home, deps } = setup(["--claude", "--yes"]);
		seedClaude(home, {
			model: "opus",
			hooks: {
				PreToolUse: [
					{ matcher: "mcp__old__.*", hooks: [{ type: "command", command: "$HOME/.local/bin/warden hook pretool" }] },
					{ matcher: "Bash", hooks: [{ type: "command", command: "rtk-rewrite" }] },
				],
			},
		});
		expect(await runInstall(c, deps)).toBe(0);
		const hooks = JSON.parse(read(claudeFile(home, "settings.json"))).hooks;
		expect(hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "rtk-rewrite" }] }]);
		expect(hooks.SessionEnd).toHaveLength(1);
	});

	test("invalid settings.json → error step, file untouched, exit 1", async () => {
		const { c, home, deps } = setup(["--claude", "--yes", "--json"]);
		seedClaude(home);
		writeFileSync(claudeFile(home, "settings.json"), "{ nope");
		expect(await runInstall(c, deps)).toBe(1);
		expect(read(claudeFile(home, "settings.json"))).toBe("{ nope");
		expect(JSON.parse(c.stdout.join("\n")).steps[3]).toMatchObject({ step: "settings", status: "error" });
	});

	test("keeps tab indentation of an existing settings.json", async () => {
		const { c, home, deps } = setup(["--claude", "--yes"]);
		seedClaude(home);
		writeFileSync(claudeFile(home, "settings.json"), '{\n\t"model": "opus"\n}\n');
		await runInstall(c, deps);
		expect(read(claudeFile(home, "settings.json"))).toStartWith('{\n\t"model": "opus",\n\t"hooks"');
	});

	test("no flags: detected ~/.claude → Claude steps run", async () => {
		const { c, home, deps } = setup(["--yes", "--json"]);
		seedClaude(home);
		expect(await runInstall(c, deps)).toBe(0);
		const steps = JSON.parse(c.stdout.join("\n")).steps.map((s: { step: string }) => s.step);
		expect(steps).toEqual(["binary", "skill", "rule", "settings"]);
		expect(existsSync(codexFile(home, "hooks.json"))).toBe(false);
	});

	test("no flags: detected ~/.codex → Codex hooks.json written after confirming; ~/.claude untouched", async () => {
		const { c, home, deps, questions } = setup([]);
		mkdirSync(codexFile(home), { recursive: true });
		expect(await runInstall(c, deps)).toBe(0);
		const hooks = JSON.parse(read(codexFile(home, "hooks.json"))).hooks;
		expect(hooks.PreToolUse).toBeUndefined();
		expect(hooks.SessionEnd[0].hooks[0]).toEqual({
			type: "command",
			command: "$HOME/.local/bin/warden hook session-end",
			timeout: 3,
		});
		expect(questions).toEqual([`apply these changes to ${codexFile(home, "hooks.json")}?`]);
		expect(existsSync(join(home, ".claude"))).toBe(false);
		const out = c.stdout.join("\n");
		expect(out).toContain("codex-hooks");
		expect(out).toContain("/hooks");
	});

	test("no flags: both detected → both installed", async () => {
		const { c, home, deps } = setup(["--yes", "--json"]);
		seedClaude(home);
		mkdirSync(codexFile(home), { recursive: true });
		expect(await runInstall(c, deps)).toBe(0);
		const steps = JSON.parse(c.stdout.join("\n")).steps.map((s: { step: string }) => s.step);
		expect(steps).toEqual(["binary", "skill", "rule", "settings", "codex-hooks"]);
	});

	test("--claude forces Claude only, even when Codex is detected", async () => {
		const { c, home, deps } = setup(["--claude", "--yes"]);
		mkdirSync(codexFile(home), { recursive: true });
		expect(await runInstall(c, deps)).toBe(0);
		expect(existsSync(claudeFile(home, "settings.json"))).toBe(true);
		expect(existsSync(codexFile(home, "hooks.json"))).toBe(false);
	});

	test("--codex forces Codex (creates ~/.codex/hooks.json) and skips Claude even when detected", async () => {
		const { c, home, deps } = setup(["--codex", "--yes", "--json"]);
		seedClaude(home);
		expect(await runInstall(c, deps)).toBe(0);
		expect(JSON.parse(read(codexFile(home, "hooks.json"))).hooks.SessionEnd).toHaveLength(1);
		expect(JSON.parse(read(claudeFile(home, "settings.json")))).toEqual({ model: "opus" });
		const steps = JSON.parse(c.stdout.join("\n")).steps.map((s: { step: string }) => s.step);
		expect(steps).toEqual(["binary", "codex-hooks"]);
	});

	test("--claude --codex installs both", async () => {
		const { c, home, deps } = setup(["--claude", "--codex", "--yes"]);
		expect(await runInstall(c, deps)).toBe(0);
		expect(existsSync(claudeFile(home, "settings.json"))).toBe(true);
		expect(existsSync(codexFile(home, "hooks.json"))).toBe(true);
	});

	test("--codex honours $CODEX_HOME", async () => {
		const { c, home, deps } = setup(["--codex", "--yes"]);
		const custom = join(home, "cx");
		c.env = { ...c.env, CODEX_HOME: custom };
		expect(await runInstall(c, deps)).toBe(0);
		expect(existsSync(join(custom, "hooks.json"))).toBe(true);
		expect(existsSync(codexFile(home, "hooks.json"))).toBe(false);
	});

	test("--codex preserves an existing hooks.json and is idempotent", async () => {
		const { c, home, deps, questions } = setup(["--codex"]);
		mkdirSync(codexFile(home), { recursive: true });
		const existing = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard" }] }] } };
		writeFileSync(codexFile(home, "hooks.json"), `${JSON.stringify(existing, null, 2)}\n`);
		await runInstall(c, deps);
		const after = read(codexFile(home, "hooks.json"));
		const hooks = JSON.parse(after).hooks;
		expect(hooks.PreToolUse).toHaveLength(1);
		expect(hooks.PreToolUse[0]).toEqual(existing.hooks.PreToolUse[0]);
		questions.length = 0;
		c.argv = ["--codex", "--json"];
		c.stdout.length = 0;
		expect(await runInstall(c, deps)).toBe(0);
		expect(questions).toEqual([]);
		expect(read(codexFile(home, "hooks.json"))).toBe(after);
		expect(JSON.parse(c.stdout.join("\n")).steps[1]).toMatchObject({ step: "codex-hooks", status: "unchanged" });
	});

	test("--codex: warden hooks already in config.toml → unchanged, no hooks.json", async () => {
		const { c, home, deps } = setup(["--codex", "--yes", "--json"]);
		mkdirSync(codexFile(home), { recursive: true });
		writeFileSync(
			codexFile(home, "config.toml"),
			[
				"[[hooks.SessionEnd]]",
				"[[hooks.SessionEnd.hooks]]",
				'type = "command"',
				'command = "warden hook session-end"',
				"",
			].join("\n")
		);
		expect(await runInstall(c, deps)).toBe(0);
		expect(existsSync(codexFile(home, "hooks.json"))).toBe(false);
		expect(JSON.parse(c.stdout.join("\n")).steps[1]).toMatchObject({
			step: "codex-hooks",
			status: "unchanged",
			path: codexFile(home, "config.toml"),
		});
	});

	test("--codex --dry-run writes nothing but prints the diff", async () => {
		const { c, home, deps, questions } = setup(["--codex", "--dry-run"]);
		expect(await runInstall(c, deps)).toBe(0);
		expect(existsSync(codexFile(home))).toBe(false);
		expect(questions).toEqual([]);
		expect(c.stdout.join("\n")).toContain("hook session-end");
	});

	test("--codex non-interactive without --yes → skipped", async () => {
		const { c, home, deps } = setup(["--codex", "--json"], { interactive: false });
		expect(await runInstall(c, deps)).toBe(0);
		expect(existsSync(codexFile(home, "hooks.json"))).toBe(false);
		expect(JSON.parse(c.stdout.join("\n")).steps[1]).toMatchObject({ step: "codex-hooks", status: "skipped" });
	});

	test("--codex: invalid hooks.json → error, untouched, exit 1", async () => {
		const { c, home, deps } = setup(["--codex", "--yes"]);
		mkdirSync(codexFile(home), { recursive: true });
		writeFileSync(codexFile(home, "hooks.json"), "{ nope");
		expect(await runInstall(c, deps)).toBe(1);
		expect(read(codexFile(home, "hooks.json"))).toBe("{ nope");
	});

	test("no HOME → exit 1", async () => {
		const { c, deps } = setup([]);
		c.env = { ...c.env, HOME: undefined };
		expect(await runInstall(c, deps)).toBe(1);
	});
});

describe("warden install (skill via the skills CLI + rule)", () => {
	const skillDir = (home: string) => claudeFile(home, "skills", "warden");
	const stagedRoot = (c: TestContext) => join(c.env.WARDEN_HOME ?? "", "skill");
	const stepsOf = (c: TestContext): Array<{ step: string; status: string; path: string; detail?: string }> =>
		JSON.parse(c.stdout.join("\n")).steps;

	test("--claude stages the folder and runs `skills add … -a claude-code`; the rule is written directly", async () => {
		const s = setup(["--claude", "--yes", "--json"]);
		seedClaude(s.home);
		expect(await runInstall(s.c, s.deps)).toBe(0);
		expect(s.runs).toEqual([
			["bunx", "skills", "add", stagedRoot(s.c), "--skill", "warden", "-g", "-a", "claude-code", "-y"],
		]);
		for (const p of SKILL_PATHS) expect(read(join(stagedRoot(s.c), "warden", p))).toBe(SKILL_FILES[p]);
		expect(read(join(skillDir(s.home), "SKILL.md"))).toBe(SKILL_FILES["SKILL.md"]);
		expect(read(claudeFile(s.home, "rules", "warden.md"))).toBe(RULE_MD);
		const steps = stepsOf(s.c);
		expect(steps.map((x) => x.step)).toEqual(["binary", "skill", "rule", "settings"]);
		expect(steps[1]).toMatchObject({ status: "written", path: skillDir(s.home) });
		expect(steps[2]?.path).toBe(claudeFile(s.home, "rules", "warden.md"));
	});

	test("--json sends the skills CLI's stdout to stderr; human mode inherits it", async () => {
		const json = setup(["--claude", "--yes", "--json"]);
		seedClaude(json.home);
		await runInstall(json.c, json.deps);
		expect(json.runOpts).toEqual([{ stdout: "stderr" }]);
		const human = setup(["--claude", "--yes"]);
		seedClaude(human.home);
		await runInstall(human.c, human.deps);
		expect(human.runOpts).toEqual([{ stdout: "inherit" }]);
	});

	test("without --yes the command has no -y", async () => {
		const s = setup(["--claude", "--json"]);
		seedClaude(s.home);
		await runInstall(s.c, s.deps);
		expect(s.runs[0]).not.toContain("-y");
	});

	test("staging recreates the folder from scratch (drops stale files)", async () => {
		const s = setup(["--claude", "--yes", "--json"]);
		seedClaude(s.home);
		const old = join(stagedRoot(s.c), "warden", "references", "old.md");
		mkdirSync(join(old, ".."), { recursive: true });
		writeFileSync(old, "old");
		await runInstall(s.c, s.deps);
		expect(existsSync(old)).toBe(false);
	});

	test("skill already current on disk → unchanged, skills CLI not run", async () => {
		const s = setup(["--claude", "--yes", "--json"]);
		seedClaude(s.home);
		for (const p of SKILL_PATHS) {
			mkdirSync(join(skillDir(s.home), p, ".."), { recursive: true });
			writeFileSync(join(skillDir(s.home), p), SKILL_FILES[p]);
		}
		expect(await runInstall(s.c, s.deps)).toBe(0);
		expect(s.runs).toEqual([]);
		expect(stepsOf(s.c)[1]).toMatchObject({ step: "skill", status: "unchanged" });
	});

	test("--dry-run runs and stages nothing; detail is the command", async () => {
		const s = setup(["--claude", "--dry-run", "--json"]);
		seedClaude(s.home);
		expect(await runInstall(s.c, s.deps)).toBe(0);
		expect(s.runs).toEqual([]);
		expect(existsSync(stagedRoot(s.c))).toBe(false);
		expect(existsSync(claudeFile(s.home, "rules"))).toBe(false);
		const step = stepsOf(s.c)[1];
		expect(step?.status).toBe("dry-run");
		expect(step?.detail).toContain("bunx skills add");
		expect(step?.detail).toContain(stagedRoot(s.c));
	});

	test("--dry-run still diffs the rule", async () => {
		const s = setup(["--claude", "--dry-run"]);
		seedClaude(s.home);
		await runInstall(s.c, s.deps);
		expect(s.c.stdout.join("\n")).toContain(`--- ${claudeFile(s.home, "rules", "warden.md")}`);
	});

	test("skills CLI failure → step failed with the exit code; other steps still run; exit 1", async () => {
		const s = setup(["--claude", "--yes", "--json"], { skillExit: 3 });
		seedClaude(s.home);
		expect(await runInstall(s.c, s.deps)).toBe(1);
		const steps = stepsOf(s.c);
		expect(steps[1]).toMatchObject({ step: "skill", status: "failed" });
		expect(steps[1]?.detail).toContain("3");
		expect(steps[2]).toMatchObject({ step: "rule", status: "written" });
		expect(steps[3]).toMatchObject({ step: "settings", status: "written" });
	});

	test("no bunx → npx --yes", async () => {
		const s = setup(["--claude", "--yes", "--json"], { which: { npx: "/usr/bin/npx" } });
		seedClaude(s.home);
		await runInstall(s.c, s.deps);
		expect(s.runs[0]?.slice(0, 4)).toEqual(["npx", "--yes", "skills", "add"]);
	});

	test("neither bunx nor npx → skill skipped with a hint; install carries on, exit 0", async () => {
		const s = setup(["--claude", "--yes", "--json"], { which: {} });
		seedClaude(s.home);
		expect(await runInstall(s.c, s.deps)).toBe(0);
		const steps = stepsOf(s.c);
		expect(steps[1]).toMatchObject({ step: "skill", status: "skipped" });
		expect(steps[1]?.detail).toContain("warden skill show");
		expect(steps[2]).toMatchObject({ step: "rule", status: "written" });
	});

	test("second run → rule unchanged", async () => {
		const s = setup(["--claude", "--yes", "--json"]);
		seedClaude(s.home);
		await runInstall(s.c, s.deps);
		s.c.stdout.length = 0;
		expect(await runInstall(s.c, s.deps)).toBe(0);
		expect(stepsOf(s.c)[2]).toMatchObject({ step: "rule", status: "unchanged" });
	});

	test("legacy agent-device / argent rules get a note and are left alone", async () => {
		const { c, home, deps } = setup(["--claude", "--yes", "--json"]);
		seedClaude(home);
		mkdirSync(claudeFile(home, "rules"), { recursive: true });
		writeFileSync(claudeFile(home, "rules", "agent-device.md"), "legacy");
		expect(legacyRules(claudeFile(home))).toEqual([claudeFile(home, "rules", "agent-device.md")]);
		expect(await runInstall(c, deps)).toBe(0);
		expect(read(claudeFile(home, "rules", "agent-device.md"))).toBe("legacy");
		const notes: string[] = JSON.parse(c.stdout.join("\n")).notes;
		expect(notes.some((n) => n.includes("rules/agent-device.md") && n.includes("retired"))).toBe(true);
	});
});

describe("warden install (prompts + ui)", () => {
	test("interactive: asks once per agent-config change, after its diff", async () => {
		const { c, home, deps, ui } = setup(["--claude"]);
		seedClaude(home);
		expect(await runInstall(c, deps)).toBe(0);
		expect(ui.events).toEqual([`confirm: apply these changes to ${claudeFile(home, "settings.json")}?`]);
		expect(c.stdout.join("\n")).toContain(`--- ${claudeFile(home, "settings.json")}`);
	});

	test("cancelled prompt skips only that step", async () => {
		const { c, home, deps, questions } = setup(["--claude", "--json"], { confirm: [undefined] });
		seedClaude(home);
		expect(await runInstall(c, deps)).toBe(0);
		expect(questions).toHaveLength(1);
		expect(JSON.parse(read(claudeFile(home, "settings.json")))).toEqual({ model: "opus" });
		const steps = JSON.parse(c.stdout.join("\n")).steps;
		expect(steps[3]).toMatchObject({ step: "settings", status: "skipped", detail: "cancelled" });
	});

	test("--json: diffs go to stderr, stdout is one JSON document", async () => {
		const { c, home, deps } = setup(["--claude", "--yes", "--json"]);
		seedClaude(home);
		expect(await runInstall(c, deps)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n")).steps).toHaveLength(4);
		expect(c.stderr.join("\n")).toContain("hook session-end");
	});

	test("human mode colours the diff (+ green, - red, context dim) and step marks", async () => {
		const { c, home, deps, ui } = setup(["--claude", "--yes"]);
		c.ui = { ...ui, color: new Chalk({ level: 1 }) };
		seedClaude(home);
		expect(await runInstall(c, deps)).toBe(0);
		const out = c.stdout.join("\n");
		expect(out).toContain('\u001b[32m+     "SessionEnd": [');
		expect(out).toContain('\u001b[31m-   "model": "opus"\u001b[39m');
		expect(out).toContain("\u001b[32m✓\u001b[39m settings");
	});

	test("--json diffs stay plain even with colour on", async () => {
		const { c, home, deps, ui } = setup(["--claude", "--yes", "--json"]);
		c.ui = { ...ui, color: new Chalk({ level: 1 }) };
		seedClaude(home);
		await runInstall(c, deps);
		expect([...c.stdout, ...c.stderr].join("\n")).not.toContain("\u001b[");
	});

	test("unknown option → commander usage error, exit 1, nothing written", async () => {
		const { c, home, deps } = setup(["--bogus"]);
		expect(await runInstall(c, deps)).toBe(1);
		expect(c.stderr.join("\n")).toContain("unknown option '--bogus'");
		expect(existsSync(join(home, ".local"))).toBe(false);
	});

	test("-y is --yes", async () => {
		const { c, home, deps, questions } = setup(["--claude", "-y"], { interactive: false });
		seedClaude(home);
		expect(await runInstall(c, deps)).toBe(0);
		expect(questions).toEqual([]);
		expect(JSON.parse(read(claudeFile(home, "settings.json"))).hooks.SessionEnd).toHaveLength(1);
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

describe("warden install: shell completion", () => {
	const stepOf = (c: TestContext, name: string) =>
		(JSON.parse(c.stdout.join("\n")) as { steps: Array<{ step: string; status: string; path: string }> }).steps.find(
			(s) => s.step === name
		);

	test("zsh: writes the script under $WARDEN_HOME and sources it from .zshrc after a confirm", async () => {
		const { c, home, deps, questions } = setup(["--json"]);
		c.env = { ...c.env, SHELL: "/bin/zsh" };
		writeFileSync(join(home, ".zshrc"), "autoload -Uz compinit\ncompinit\n");
		expect(await runInstall(c, deps)).toBe(0);
		const script = join(c.env.WARDEN_HOME ?? "", "completion", "warden.zsh");
		expect(read(script)).toContain("compdef _warden warden");
		const rc = read(join(home, ".zshrc"));
		expect(rc.startsWith("autoload -Uz compinit\ncompinit\n")).toBe(true);
		expect(rc).toContain(`source "${script}"`);
		expect(questions.some((q) => q.includes(".zshrc"))).toBe(true);
		expect(stepOf(c, "completion")).toMatchObject({ status: "written", path: join(home, ".zshrc") });
	});

	test("a second install leaves .zshrc alone", async () => {
		const first = setup(["--json"]);
		first.c.env = { ...first.c.env, SHELL: "/bin/zsh" };
		await runInstall(first.c, first.deps);
		const before = read(join(first.home, ".zshrc"));
		first.c.stdout.length = 0;
		expect(await runInstall(first.c, first.deps)).toBe(0);
		expect(read(join(first.home, ".zshrc"))).toBe(before);
		expect(stepOf(first.c, "completion")?.status).toBe("unchanged");
	});

	test("bash: .bashrc; fish: the completions dir, no rc edit", async () => {
		const bash = setup(["--json"]);
		bash.c.env = { ...bash.c.env, SHELL: "/bin/bash" };
		await runInstall(bash.c, bash.deps);
		expect(read(join(bash.home, ".bashrc"))).toContain("warden.bash");
		bash.c.cleanup();

		const fish = setup(["--json"]);
		fish.c.env = { ...fish.c.env, SHELL: "/usr/local/bin/fish" };
		await runInstall(fish.c, fish.deps);
		const path = join(fish.home, ".config", "fish", "completions", "warden.fish");
		expect(read(path)).toContain("complete -c warden");
		expect(stepOf(fish.c, "completion")).toMatchObject({ status: "written", path });
	});

	test("declining the rc edit is a declined step, nothing appended", async () => {
		const { c, home, deps } = setup(["--json"], { confirm: [false, false, false, false, false] });
		c.env = { ...c.env, SHELL: "/bin/zsh" };
		await runInstall(c, deps);
		expect(existsSync(join(home, ".zshrc"))).toBe(false);
		expect(stepOf(c, "completion")?.status).toBe("declined");
	});

	test("--no-completion and an unknown $SHELL skip the step", async () => {
		const off = setup(["--json", "--no-completion"]);
		off.c.env = { ...off.c.env, SHELL: "/bin/zsh" };
		await runInstall(off.c, off.deps);
		expect(stepOf(off.c, "completion")).toBeUndefined();
		off.c.cleanup();

		const tcsh = setup(["--json"]);
		tcsh.c.env = { ...tcsh.c.env, SHELL: "/bin/tcsh" };
		await runInstall(tcsh.c, tcsh.deps);
		expect(stepOf(tcsh.c, "completion")).toBeUndefined();
	});
});
