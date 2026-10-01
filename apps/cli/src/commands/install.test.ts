import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Chalk } from "chalk";
import { WARDEN_RULE_LINE } from "../hooks/argent-rules";
import { type ScriptedUi, scriptedUi, type TestContext, testContext } from "../testing";
import { installOrigin } from "../update/install-origin";
import { createInstallCommand, detectRuntime, type InstallDeps, type Runtime } from "./install";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const ARGENT = "<device_selection_rule>\nDecision order:\n\n1. **Explicit user intent**\n</device_selection_rule>\n";

type Setup = { c: TestContext; home: string; deps: InstallDeps; questions: string[]; ui: ScriptedUi };

type SetupOpts = {
	runtime?: Runtime;
	interactive?: boolean;
	/** scripted confirm answers (undefined = cancelled); default: yes to everything */
	confirm?: Array<boolean | undefined>;
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
	const deps: InstallDeps = { runtime: opts.runtime ?? { kind: "compiled", execPath: binary } };
	return { c, home, deps, questions, ui };
}

const runInstall = (c: TestContext, deps: InstallDeps) => createInstallCommand(() => deps).run(c);

const read = (path: string) => readFileSync(path, "utf8");
const claudeFile = (home: string, ...parts: string[]) => join(home, ".claude", ...parts);
const codexFile = (home: string, ...parts: string[]) => join(home, ".codex", ...parts);

function seedClaude(home: string, settings: unknown = { model: "opus" }) {
	mkdirSync(claudeFile(home, "rules"), { recursive: true });
	writeFileSync(claudeFile(home, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
	writeFileSync(claudeFile(home, "rules", "argent.md"), ARGENT);
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
		const { c, home, deps } = setup(["--claude", "--json"], { confirm: [false, false, false, false] });
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

	test("no flags: detected ~/.claude → Claude steps run", async () => {
		const { c, home, deps } = setup(["--yes", "--json"]);
		seedClaude(home);
		expect(await runInstall(c, deps)).toBe(0);
		const steps = JSON.parse(c.stdout.join("\n")).steps.map((s: { step: string }) => s.step);
		expect(steps).toEqual(["binary", "skill", "settings", "argent-rules"]);
		expect(existsSync(codexFile(home, "hooks.json"))).toBe(false);
	});

	test("no flags: detected ~/.codex → Codex hooks.json written after confirming; ~/.claude untouched", async () => {
		const { c, home, deps, questions } = setup([]);
		mkdirSync(codexFile(home), { recursive: true });
		expect(await runInstall(c, deps)).toBe(0);
		const hooks = JSON.parse(read(codexFile(home, "hooks.json"))).hooks;
		expect(hooks.PreToolUse[0].matcher).toBe("mcp__argent__.*|mcp__plugin_goldie_argent__.*");
		expect(hooks.PreToolUse[0].hooks[0].command).toBe("$HOME/.local/bin/warden hook pretool");
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
		expect(steps).toEqual(["binary", "skill", "settings", "argent-rules", "codex-hooks"]);
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
		expect(hooks.PreToolUse).toHaveLength(2);
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
				"[[hooks.PreToolUse]]",
				'matcher = "mcp__argent__.*"',
				"[[hooks.PreToolUse.hooks]]",
				'type = "command"',
				'command = "warden hook pretool"',
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

describe("warden install (prompts + ui)", () => {
	test("interactive: asks once per agent-config change, after its diff", async () => {
		const { c, home, deps, ui } = setup(["--claude"]);
		seedClaude(home);
		expect(await runInstall(c, deps)).toBe(0);
		expect(ui.events).toEqual([
			`confirm: apply these changes to ${claudeFile(home, "settings.json")}?`,
			`confirm: apply these changes to ${claudeFile(home, "rules", "argent.md")}?`,
		]);
		const out = c.stdout.join("\n");
		expect(out.indexOf(`--- ${claudeFile(home, "settings.json")}`)).toBeLessThan(
			out.indexOf(`--- ${claudeFile(home, "rules", "argent.md")}`)
		);
	});

	test("cancelled prompt skips only that step; later steps still asked", async () => {
		const { c, home, deps, questions } = setup(["--claude", "--json"], { confirm: [undefined, true] });
		seedClaude(home);
		expect(await runInstall(c, deps)).toBe(0);
		expect(questions).toHaveLength(2);
		expect(JSON.parse(read(claudeFile(home, "settings.json")))).toEqual({ model: "opus" });
		expect(read(claudeFile(home, "rules", "argent.md"))).toContain(WARDEN_RULE_LINE);
		const steps = JSON.parse(c.stdout.join("\n")).steps;
		expect(steps[2]).toMatchObject({ step: "settings", status: "skipped", detail: "cancelled" });
		expect(steps[3]).toMatchObject({ step: "argent-rules", status: "written" });
	});

	test("--json: diffs go to stderr, stdout is one JSON document", async () => {
		const { c, home, deps } = setup(["--claude", "--yes", "--json"]);
		seedClaude(home);
		expect(await runInstall(c, deps)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n")).steps).toHaveLength(4);
		expect(c.stderr.join("\n")).toContain("hook pretool");
	});

	test("human mode colours the diff (+ green, - red, context dim) and step marks", async () => {
		const { c, home, deps, ui } = setup(["--claude", "--yes"]);
		c.ui = { ...ui, color: new Chalk({ level: 1 }) };
		seedClaude(home);
		expect(await runInstall(c, deps)).toBe(0);
		const out = c.stdout.join("\n");
		expect(out).toContain(`\u001b[32m+ ${WARDEN_RULE_LINE}\u001b[39m`);
		expect(out).toContain("\u001b[2m  Decision order:\u001b[22m");
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
		expect(read(claudeFile(home, "rules", "argent.md"))).toContain(WARDEN_RULE_LINE);
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
