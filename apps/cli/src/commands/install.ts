import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { wardenHome } from "@delacour/warden-core/store";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { type Command, defineCommand } from "../command";
import { type CompletionShell, completionScript, shellFromEnv } from "../completion-scripts";
import type { CommandContext } from "../context";
import { type Agent, detectAgents } from "../hooks/agents";
import { mergeClaudeSettings } from "../hooks/claude-settings";
import { codexConfigPath, codexHooksPath, codexTomlHasWardenHook, mergeCodexHooks } from "../hooks/codex-hooks";
import { errorMessage } from "../hooks/json";
import { lineDiff } from "../hooks/text-diff";
import { heading, reportError } from "../output";
import { RULE_MD, SKILL_NAME, staleSkillFiles } from "../skill";
import {
	CLAUDE_AGENT,
	localSkillRoot,
	realSkillDeps,
	runner,
	type SkillDeps,
	skillsAddArgs,
	stageSkillFolder,
} from "../skill-cli";
import { type InstallOrigin, recordInstallOrigin } from "../update/install-origin";
import {
	describePackageInstall,
	detectPackageInstall,
	isStableInstall,
	upgradeCommand,
} from "../update/package-install";

/** Hook commands reference the installed binary via `$HOME` so they work whatever PATH the agent runs with. */
export const HOOK_BINARY = "$HOME/.local/bin/warden";

/** How this process runs: a `bun build --compile` binary, or `bun src/cli.ts` from a checkout. */
export type Runtime = { kind: "compiled"; execPath: string } | { kind: "dev"; cliPath: string };

/** Outside world for `warden install` beyond `CommandContext` (prompts come from `ctx.ui`). */
export type InstallDeps = { runtime: Runtime; skill: SkillDeps };

export type StepName = "binary" | "skill" | "rule" | "settings" | "codex-hooks" | "completion";
export type StepStatus = "written" | "unchanged" | "skipped" | "declined" | "dry-run" | "failed" | "error";
export type StepReport = { step: StepName; status: StepStatus; path: string; detail?: string };

export type InstallFlags = {
	claude?: true;
	codex?: true;
	yes?: true;
	dryRun?: true;
	shim?: true;
	json?: true;
	/** false = `--no-completion` */
	completion?: boolean;
};
type Flags = InstallFlags;

function report(step: StepName, status: StepStatus, path: string, detail?: string): StepReport {
	return detail === undefined ? { step, status, path } : { step, status, path, detail };
}

function readIfExists(path: string): string | undefined {
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Write via temp file + rename so a running binary / concurrent reader never sees a partial file. */
function atomicWrite(path: string, content: string | Uint8Array, mode?: number): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, content);
	if (mode !== undefined) chmodSync(tmp, mode);
	renameSync(tmp, path);
}

function sameFile(a: string, b: string): boolean {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return false;
	}
}

function installBinary(ctx: CommandContext, target: string, runtime: Runtime, flags: Flags): StepReport {
	if (runtime.kind === "dev" && !flags.shim) {
		const appDir = resolve(dirname(runtime.cliPath), "..");
		return report(
			"binary",
			"skipped",
			target,
			`running from source — build a standalone binary with \`bun run --cwd ${appDir} build\` and run \`${appDir}/dist/warden install\`, or pass --shim to link this checkout`
		);
	}
	if (runtime.kind === "compiled" && sameFile(runtime.execPath, target)) return report("binary", "unchanged", target);
	const source = binarySource(runtime);
	const current = existsSync(target) ? readFileSync(target) : undefined;
	if (current && Buffer.from(source.content).equals(current)) {
		recordInstallOrigin(ctx.env, target, source.origin);
		return report("binary", "unchanged", target);
	}
	if (flags.dryRun) return report("binary", "dry-run", target, `would write ${source.kind}`);
	atomicWrite(target, source.content, 0o755);
	recordInstallOrigin(ctx.env, target, source.origin);
	return report("binary", "written", target, source.detail);
}

/** `~/.local/bin/warden` for a source checkout: runs its `cli.ts` with bun. */
export function devShim(cliPath: string): string {
	return `#!/bin/sh\nexec bun "${cliPath}" "$@"\n`;
}

/** `origin: "npm"` = a copy from an npx / bunx run, so `warden update` fetches it from npm. */
type BinarySource = { kind: "shim" | "binary"; content: string | Uint8Array; detail?: string; origin?: InstallOrigin };

/**
 * What `~/.local/bin/warden` should be: a shim for a source checkout or a global npm/bun/pnpm install
 * (a stable path its package manager upgrades in place), otherwise a copy of the running binary.
 */
function binarySource(runtime: Runtime): BinarySource {
	if (runtime.kind === "dev") {
		return {
			kind: "shim",
			content: devShim(runtime.cliPath),
			detail: `shim → ${runtime.cliPath}`,
		};
	}
	const managed = detectPackageInstall(runtime.execPath);
	if (managed && isStableInstall(managed)) {
		return {
			kind: "shim",
			content: `#!/bin/sh\nexec "${runtime.execPath}" "$@"\n`,
			detail: `shim → ${describePackageInstall(managed)}; \`${upgradeCommand(managed)}\` upgrades it`,
		};
	}
	const content = readFileSync(runtime.execPath);
	if (!managed) return { kind: "binary", content };
	return {
		kind: "binary",
		content,
		detail: `copied from ${describePackageInstall(managed)}; \`warden update\` or \`${upgradeCommand(managed)}\` refreshes it`,
		origin: "npm",
	};
}

/**
 * Claude Code skill: stage the embedded folder under `$WARDEN_HOME/skill/warden` and let the `skills` CLI
 * (`skills add … -a claude-code`) place it in `~/.claude/skills/warden`. Already-current on disk → unchanged.
 */
async function installSkill(ctx: CommandContext, deps: SkillDeps, dir: string, flags: Flags): Promise<StepReport> {
	const { missing, outdated } = staleSkillFiles(dir);
	if (missing.length === 0 && outdated.length === 0) return report("skill", "unchanged", dir);
	const prefix = runner(deps);
	if (!prefix)
		return report("skill", "skipped", dir, "neither bunx nor npx found — install bun or node, or `warden skill show`");
	const root = localSkillRoot(ctx);
	const cmd = [...prefix, ...skillsAddArgs(root, { agent: [CLAUDE_AGENT], yes: flags.yes })];
	if (flags.dryRun)
		return report("skill", "dry-run", dir, `would stage ${join(root, SKILL_NAME)} and run ${cmd.join(" ")}`);
	stageSkillFolder(ctx);
	ctx.err(flags.json ? `warden install: ${cmd.join(" ")}` : ctx.ui.color.dim(`warden install: ${cmd.join(" ")}`));
	const code = await deps.runInteractive(cmd, { stdout: flags.json ? "stderr" : "inherit" });
	return code === 0
		? report("skill", "written", dir, cmd.join(" "))
		: report("skill", "failed", dir, `skills CLI exited ${code}`);
}

/** `~/.claude/rules/warden.md`: the always-loaded rule. */
function installRule(ctx: CommandContext, path: string, flags: Flags): StepReport {
	const current = readIfExists(path);
	if (current === RULE_MD) return report("rule", "unchanged", path);
	if (flags.dryRun) {
		showDiff(ctx, flags, lineDiff(current ?? "", RULE_MD, path));
		return report("rule", "dry-run", path);
	}
	atomicWrite(path, RULE_MD);
	return report("rule", "written", path);
}

/** Rules from the retired agent-device / argent setup that exist under `claudeDir` (never deleted by install). */
export function legacyRules(claudeDir: string): string[] {
	return ["agent-device.md", "argent.md"].map((f) => join(claudeDir, "rules", f)).filter((p) => existsSync(p));
}

/** Diff lines coloured like git: + green, - red, context dim. */
function colorDiff(ctx: CommandContext, diff: string): string {
	const { color } = ctx.ui;
	return diff
		.split("\n")
		.map((line) => {
			if (line.startsWith("--- ") || line.startsWith("+++ ")) return color.bold(line);
			if (line === "@@") return color.cyan(line);
			if (line.startsWith("+ ")) return color.green(line);
			if (line.startsWith("- ")) return color.red(line);
			return color.dim(line);
		})
		.join("\n");
}

/** Human mode: coloured diff on stdout. `--json`: plain diff on stderr (stdout is the JSON report). */
function showDiff(ctx: CommandContext, flags: Flags, diff: string): void {
	if (diff === "") return;
	if (flags.json) ctx.err(diff);
	else ctx.out(colorDiff(ctx, diff));
}

/**
 * Show the diff, then write only on --yes or an interactive "yes". Non-interactive without --yes
 * skips the step (naming the flag); "no" declines it; a cancelled prompt skips just this step.
 */
async function guardedWrite(
	ctx: CommandContext,
	flags: Flags,
	step: StepName,
	path: string,
	before: string,
	after: string
): Promise<StepReport> {
	showDiff(ctx, flags, lineDiff(before, after, path));
	if (flags.dryRun) return report(step, "dry-run", path);
	if (!flags.yes) {
		if (!ctx.ui.interactive) return report(step, "skipped", path, "needs confirmation — re-run with --yes");
		const answer = await ctx.ui.confirm(`apply these changes to ${path}?`);
		if (answer === undefined) return report(step, "skipped", path, "cancelled");
		if (!answer) return report(step, "declined", path);
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, after);
	return report(step, "written", path);
}

function parseJson(text: string | undefined): Result<unknown> {
	if (text === undefined || text.trim() === "") return ok(undefined);
	try {
		return ok(JSON.parse(text));
	} catch (error) {
		return err(`invalid JSON: ${errorMessage(error)}`);
	}
}

async function installSettings(ctx: CommandContext, flags: Flags, path: string): Promise<StepReport> {
	const before = readIfExists(path);
	const parsed = parseJson(before);
	if (!parsed.success) return report("settings", "error", path, parsed.error);
	const merged = mergeClaudeSettings(parsed.data, HOOK_BINARY);
	if (!merged.success) return report("settings", "error", path, merged.error);
	if (!merged.data.changed) return report("settings", "unchanged", path);
	return guardedWrite(ctx, flags, "settings", path, before ?? "", formatJson(merged.data.settings, before));
}

/** Pretty JSON keeping the existing file's tab indentation. */
function formatJson(value: unknown, before: string | undefined): string {
	const indent = before !== undefined && /^\t/m.test(before) ? "\t" : 2;
	return `${JSON.stringify(value, null, indent)}\n`;
}

/**
 * Codex: merge warden's hooks into `$CODEX_HOME/hooks.json`. Codex also reads `[hooks]` tables from
 * `config.toml` (and merges both); warden hooks already declared there count as installed.
 */
async function installCodexHooks(
	ctx: CommandContext,
	flags: Flags,
	path: string,
	configPath: string
): Promise<StepReport> {
	const toml = readIfExists(configPath);
	if (codexTomlHasWardenHook(toml, "session-end")) {
		return report("codex-hooks", "unchanged", configPath);
	}
	const before = readIfExists(path);
	const parsed = parseJson(before);
	if (!parsed.success) return report("codex-hooks", "error", path, parsed.error);
	const merged = mergeCodexHooks(parsed.data, HOOK_BINARY);
	if (!merged.success) return report("codex-hooks", "error", path, merged.error);
	if (!merged.data.changed) return report("codex-hooks", "unchanged", path);
	return guardedWrite(ctx, flags, "codex-hooks", path, before ?? "", formatJson(merged.data.settings, before));
}

/** fish autoloads its completions dir; zsh / bash source warden's copy from their rc file. */
function completionPaths(
	env: Record<string, string | undefined>,
	home: string,
	shell: CompletionShell
): { script: string; rc?: string } {
	switch (shell) {
		case "fish":
			return { script: join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "fish", "completions", "warden.fish") };
		case "zsh":
			return { script: join(wardenHome(env), "completion", "warden.zsh"), rc: join(env.ZDOTDIR ?? home, ".zshrc") };
		case "bash":
			return { script: join(wardenHome(env), "completion", "warden.bash"), rc: join(home, ".bashrc") };
	}
}

/**
 * Tab completion for `$SHELL`: the script is warden's own file (rewritten when it changes); the one
 * `source` line appended to `.zshrc` / `.bashrc` goes through the diff + confirm like agent configs.
 */
async function installCompletion(
	ctx: CommandContext,
	flags: Flags,
	home: string,
	shell: CompletionShell
): Promise<StepReport> {
	const content = completionScript(shell);
	const { script, rc } = completionPaths(ctx.env, home, shell);
	const scriptChanged = readIfExists(script) !== content;
	if (scriptChanged && !flags.dryRun) atomicWrite(script, content);
	const scriptStatus: StepStatus = !scriptChanged ? "unchanged" : flags.dryRun ? "dry-run" : "written";
	if (!rc) return report("completion", scriptStatus, script);
	const before = readIfExists(rc) ?? "";
	if (before.includes(script)) return report("completion", scriptStatus, rc);
	const gap = before === "" || before.endsWith("\n") ? "" : "\n";
	const after = `${before}${gap}\n# warden tab completion (added by warden install)\n[ -f "${script}" ] && source "${script}"\n`;
	return guardedWrite(ctx, flags, "completion", rc, before, after);
}

async function step(name: StepName, path: string, fn: () => StepReport | Promise<StepReport>): Promise<StepReport> {
	try {
		return await fn();
	} catch (error) {
		return report(name, "error", path, errorMessage(error));
	}
}

const MARK: Record<StepStatus, string> = {
	written: "✓",
	unchanged: "✓",
	"dry-run": "·",
	skipped: "!",
	declined: "!",
	failed: "✗",
	error: "✗",
};

/** `--claude` / `--codex` force those agents; with neither, every detected agent. */
function targetAgents(ctx: CommandContext, flags: Flags): Agent[] {
	if (!flags.claude && !flags.codex) return detectAgents(ctx.env);
	const agents: Agent[] = [];
	if (flags.claude) agents.push("claude");
	if (flags.codex) agents.push("codex");
	return agents;
}

async function install(
	ctx: CommandContext,
	deps: InstallDeps,
	flags: Flags,
	home: string,
	agents: Agent[]
): Promise<StepReport[]> {
	const binary = join(home, ".local", "bin", "warden");
	const steps: StepReport[] = [await step("binary", binary, () => installBinary(ctx, binary, deps.runtime, flags))];
	if (agents.includes("claude")) {
		const claude = join(home, ".claude");
		const skillDir = join(claude, "skills", "warden");
		const rulePath = join(claude, "rules", "warden.md");
		const settingsPath = join(claude, "settings.json");
		steps.push(await step("skill", skillDir, () => installSkill(ctx, deps.skill, skillDir, flags)));
		steps.push(await step("rule", rulePath, () => installRule(ctx, rulePath, flags)));
		steps.push(await step("settings", settingsPath, () => installSettings(ctx, flags, settingsPath)));
	}
	const hooksPath = codexHooksPath({ ...ctx.env, HOME: home });
	const configPath = codexConfigPath({ ...ctx.env, HOME: home });
	if (agents.includes("codex") && hooksPath && configPath) {
		steps.push(await step("codex-hooks", hooksPath, () => installCodexHooks(ctx, flags, hooksPath, configPath)));
	}
	const shell = flags.completion === false ? undefined : shellFromEnv(ctx.env);
	if (shell) steps.push(await step("completion", shell, () => installCompletion(ctx, flags, home, shell)));
	return steps;
}

function installNotes(
	flags: Flags,
	agents: Agent[],
	steps: StepReport[],
	binaryPresent: boolean,
	home: string
): string[] {
	const notes: string[] = [];
	if (agents.length === 0) {
		notes.push("note: no Claude Code or Codex detected — installed the binary only (--claude / --codex to force)");
	}
	if (agents.length > 0 && !binaryPresent && !flags.dryRun) {
		notes.push(`note: hooks call ${HOOK_BINARY}, which is not installed yet`);
	}
	if (steps.some((s) => s.step === "codex-hooks" && s.status === "written")) {
		notes.push("note: Codex skips new hooks until trusted — run /hooks in Codex to review and trust warden's");
	}
	if (steps.some((s) => s.step === "completion" && s.status === "written")) {
		notes.push("note: open a new terminal (or `exec $SHELL`) for warden tab completion");
	}
	if (agents.includes("claude")) {
		for (const p of legacyRules(join(home, ".claude"))) {
			notes.push(
				`note: ${p} is from the retired agent-device/argent setup — warden's rule is ~/.claude/rules/warden.md; delete it if unused`
			);
		}
	}
	return notes;
}

function mark(ctx: CommandContext, status: StepStatus): string {
	const { color } = ctx.ui;
	switch (status) {
		case "written":
		case "unchanged":
			return color.green(MARK[status]);
		case "dry-run":
			return color.dim(MARK[status]);
		case "skipped":
		case "declined":
			return color.yellow(MARK[status]);
		case "failed":
		case "error":
			return color.red(MARK[status]);
	}
}

function stepLine(ctx: CommandContext, s: StepReport): string {
	const { color } = ctx.ui;
	const detail = s.detail ? `  ${color.dim(`(${s.detail})`)}` : "";
	return `${mark(ctx, s.status)} ${s.step.padEnd(12)} ${s.status.padEnd(9)} ${s.path}${detail}`;
}

/** `warden install` with an injectable runtime (tests use a temp HOME + scripted prompts). */
export async function runInstall(ctx: CommandContext, deps: InstallDeps, flags: InstallFlags): Promise<number> {
	const { color } = ctx.ui;
	const home = ctx.env.HOME;
	if (!home) {
		reportError(ctx, "install", "$HOME is not set");
		return 1;
	}
	const agents = targetAgents(ctx, flags);
	if (!flags.json) heading(ctx, "install", agents.length > 0 ? agents.join(" + ") : "binary only");
	const steps = await install(ctx, deps, flags, home, agents);
	const binaryPresent = existsSync(join(home, ".local", "bin", "warden"));
	const notes = installNotes(flags, agents, steps, binaryPresent, home);
	if (flags.json) {
		ctx.out(JSON.stringify({ steps, notes }, null, 2));
	} else {
		for (const s of steps) ctx.out(stepLine(ctx, s));
		for (const n of notes) ctx.out(color.yellow(n));
	}
	return steps.some((s) => s.status === "error" || s.status === "failed") ? 1 : 0;
}

/** Bun-compiled binaries run their entry from the embedded `/$bunfs/` filesystem. */
export function detectRuntime(main: string = Bun.main, execPath: string = process.execPath): Runtime {
	return main.startsWith("/$bunfs/") || main.startsWith("B:/~BUN/")
		? { kind: "compiled", execPath }
		: { kind: "dev", cliPath: main };
}

export function createInstallCommand(deps: () => InstallDeps): Command {
	return defineCommand({
		name: "install",
		group: "Setup",
		summary: "install warden to ~/.local/bin + hooks for detected agents (Claude Code: skill, rule, hook; Codex: hook)",
		register: (cmd, ctx, done) => {
			cmd
				.option("--claude", "install for Claude Code (default: every detected agent)")
				.option("--codex", "install for Codex (default: every detected agent)")
				.option("-y, --yes", "apply agent-config changes without asking")
				.option("--dry-run", "show what would change (diffs), write nothing")
				.option("--shim", "running from source: link ~/.local/bin/warden to this checkout")
				.option("--no-completion", "don't set up tab completion for $SHELL")
				.option("--json", "machine-readable output (diffs go to stderr)")
				.action(async (opts) => done(await runInstall(ctx, deps(), opts)));
		},
	});
}

export const installCommand: Command = createInstallCommand(() => ({
	runtime: detectRuntime(),
	skill: realSkillDeps(),
}));
