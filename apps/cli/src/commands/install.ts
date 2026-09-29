import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { err, ok, type Result } from "@warden/types/result";
import type { Command, CommandContext } from "../context";
import { type Agent, detectAgents } from "../hooks/agents";
import { patchArgentRules } from "../hooks/argent-rules";
import { mergeClaudeSettings } from "../hooks/claude-settings";
import { codexConfigPath, codexHooksPath, codexTomlHasWardenHook, mergeCodexHooks } from "../hooks/codex-hooks";
import { errorMessage } from "../hooks/json";
import { lineDiff } from "../hooks/text-diff";
import { SKILL_MD as skill } from "../skill";

const USAGE = "warden install [--claude] [--codex] [--yes] [--dry-run] [--shim] [--json]";

/** Hook commands reference the installed binary via `$HOME` so they work whatever PATH the agent runs with. */
export const HOOK_BINARY = "$HOME/.local/bin/warden";

/** How this process runs: a `bun build --compile` binary, or `bun src/cli.ts` from a checkout. */
export type Runtime = { kind: "compiled"; execPath: string } | { kind: "dev"; cliPath: string };

export type InstallDeps = {
	runtime: Runtime;
	/** true when a human can answer `confirm` (stdin is a TTY) */
	interactive: boolean;
	confirm: (question: string) => Promise<boolean>;
};

export type StepName = "binary" | "skill" | "settings" | "argent-rules" | "codex-hooks";
export type StepStatus = "written" | "unchanged" | "skipped" | "declined" | "dry-run" | "error";
export type StepReport = { step: StepName; status: StepStatus; path: string; detail?: string };

type Flags = { claude: boolean; codex: boolean; yes: boolean; dryRun: boolean; shim: boolean; json: boolean };

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

function installBinary(target: string, runtime: Runtime, flags: Flags): StepReport {
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
	const content =
		runtime.kind === "dev" ? `#!/bin/sh\nexec bun "${runtime.cliPath}" "$@"\n` : readFileSync(runtime.execPath);
	const current = existsSync(target) ? readFileSync(target) : undefined;
	if (current && Buffer.from(content).equals(current)) return report("binary", "unchanged", target);
	if (flags.dryRun)
		return report("binary", "dry-run", target, `would write ${runtime.kind === "dev" ? "shim" : "binary"}`);
	atomicWrite(target, content, 0o755);
	return report("binary", "written", target, runtime.kind === "dev" ? `shim → ${runtime.cliPath}` : undefined);
}

function installSkill(ctx: CommandContext, path: string, flags: Flags): StepReport {
	const current = readIfExists(path);
	if (current === skill) return report("skill", "unchanged", path);
	if (flags.dryRun) {
		showDiff(ctx, flags, lineDiff(current ?? "", skill, path));
		return report("skill", "dry-run", path);
	}
	atomicWrite(path, skill);
	return report("skill", "written", path);
}

function showDiff(ctx: CommandContext, flags: Flags, diff: string): void {
	if (diff === "") return;
	if (flags.json) ctx.err(diff);
	else ctx.out(diff);
}

/** Show the diff, then write only on --yes or an interactive "y". */
async function guardedWrite(
	ctx: CommandContext,
	deps: InstallDeps,
	flags: Flags,
	step: StepName,
	path: string,
	before: string,
	after: string
): Promise<StepReport> {
	showDiff(ctx, flags, lineDiff(before, after, path));
	if (flags.dryRun) return report(step, "dry-run", path);
	if (!flags.yes) {
		if (!deps.interactive) return report(step, "skipped", path, "needs confirmation — re-run with --yes");
		if (!(await deps.confirm(`apply these changes to ${path}?`))) return report(step, "declined", path);
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

async function installSettings(
	ctx: CommandContext,
	deps: InstallDeps,
	flags: Flags,
	path: string
): Promise<StepReport> {
	const before = readIfExists(path);
	const parsed = parseJson(before);
	if (!parsed.success) return report("settings", "error", path, parsed.error);
	const merged = mergeClaudeSettings(parsed.data, HOOK_BINARY);
	if (!merged.success) return report("settings", "error", path, merged.error);
	if (!merged.data.changed) return report("settings", "unchanged", path);
	return guardedWrite(ctx, deps, flags, "settings", path, before ?? "", formatJson(merged.data.settings, before));
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
	deps: InstallDeps,
	flags: Flags,
	path: string,
	configPath: string
): Promise<StepReport> {
	const toml = readIfExists(configPath);
	if (codexTomlHasWardenHook(toml, "pretool") && codexTomlHasWardenHook(toml, "session-end")) {
		return report("codex-hooks", "unchanged", configPath);
	}
	const before = readIfExists(path);
	const parsed = parseJson(before);
	if (!parsed.success) return report("codex-hooks", "error", path, parsed.error);
	const merged = mergeCodexHooks(parsed.data, HOOK_BINARY);
	if (!merged.success) return report("codex-hooks", "error", path, merged.error);
	if (!merged.data.changed) return report("codex-hooks", "unchanged", path);
	return guardedWrite(ctx, deps, flags, "codex-hooks", path, before ?? "", formatJson(merged.data.settings, before));
}

async function installArgentRules(
	ctx: CommandContext,
	deps: InstallDeps,
	flags: Flags,
	path: string
): Promise<StepReport> {
	const before = readIfExists(path);
	if (before === undefined) return report("argent-rules", "skipped", path, "argent rules not installed");
	const patch = patchArgentRules(before);
	if (patch.kind === "unchanged") {
		return patch.reason === "already-patched"
			? report("argent-rules", "unchanged", path)
			: report("argent-rules", "skipped", path, "no <device_selection_rule> block found");
	}
	return guardedWrite(ctx, deps, flags, "argent-rules", path, before, patch.text);
}

async function step(name: StepName, path: string, fn: () => StepReport | Promise<StepReport>): Promise<StepReport> {
	try {
		return await fn();
	} catch (error) {
		return report(name, "error", path, errorMessage(error));
	}
}

function parseFlags(argv: string[]): Result<Flags> {
	try {
		const { values } = parseArgs({
			args: argv,
			options: {
				claude: { type: "boolean" },
				codex: { type: "boolean" },
				yes: { type: "boolean", short: "y" },
				"dry-run": { type: "boolean" },
				shim: { type: "boolean" },
				json: { type: "boolean" },
			},
			allowPositionals: false,
			strict: true,
		});
		return ok({
			claude: values.claude === true,
			codex: values.codex === true,
			yes: values.yes === true,
			dryRun: values["dry-run"] === true,
			shim: values.shim === true,
			json: values.json === true,
		});
	} catch (error) {
		return err(error);
	}
}

const MARK: Record<StepStatus, string> = {
	written: "✓",
	unchanged: "✓",
	"dry-run": "·",
	skipped: "!",
	declined: "!",
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
	const steps: StepReport[] = [await step("binary", binary, () => installBinary(binary, deps.runtime, flags))];
	if (agents.includes("claude")) {
		const claude = join(home, ".claude");
		const skillPath = join(claude, "skills", "warden", "SKILL.md");
		const settingsPath = join(claude, "settings.json");
		const rulesPath = join(claude, "rules", "argent.md");
		steps.push(await step("skill", skillPath, () => installSkill(ctx, skillPath, flags)));
		steps.push(await step("settings", settingsPath, () => installSettings(ctx, deps, flags, settingsPath)));
		steps.push(await step("argent-rules", rulesPath, () => installArgentRules(ctx, deps, flags, rulesPath)));
	}
	const hooksPath = codexHooksPath({ ...ctx.env, HOME: home });
	const configPath = codexConfigPath({ ...ctx.env, HOME: home });
	if (agents.includes("codex") && hooksPath && configPath) {
		steps.push(await step("codex-hooks", hooksPath, () => installCodexHooks(ctx, deps, flags, hooksPath, configPath)));
	}
	return steps;
}

function installNotes(flags: Flags, agents: Agent[], steps: StepReport[], binaryPresent: boolean): string[] {
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
	return notes;
}

/** `warden install` with injectable runtime detection + confirmation (tests use a temp HOME). */
export async function runInstall(ctx: CommandContext, deps: InstallDeps): Promise<number> {
	const flags = parseFlags(ctx.argv);
	if (!flags.success) {
		ctx.err(`warden install: ${flags.error}\n${USAGE}`);
		return 1;
	}
	const home = ctx.env.HOME;
	if (!home) {
		ctx.err("warden install: $HOME is not set");
		return 1;
	}
	const agents = targetAgents(ctx, flags.data);
	const steps = await install(ctx, deps, flags.data, home, agents);
	const binaryPresent = existsSync(join(home, ".local", "bin", "warden"));
	const notes = installNotes(flags.data, agents, steps, binaryPresent);
	if (flags.data.json) {
		ctx.out(JSON.stringify({ steps, notes }, null, 2));
	} else {
		for (const s of steps) {
			ctx.out(
				`${MARK[s.status]} ${s.step.padEnd(12)} ${s.status.padEnd(9)} ${s.path}${s.detail ? `  (${s.detail})` : ""}`
			);
		}
		for (const n of notes) ctx.out(n);
	}
	return steps.some((s) => s.status === "error") ? 1 : 0;
}

/** Bun-compiled binaries run their entry from the embedded `/$bunfs/` filesystem. */
export function detectRuntime(main: string = Bun.main, execPath: string = process.execPath): Runtime {
	return main.startsWith("/$bunfs/") || main.startsWith("B:/~BUN/")
		? { kind: "compiled", execPath }
		: { kind: "dev", cliPath: main };
}

/** Line prompt on the controlling terminal; anything but y/yes is "no". */
async function confirmPrompt(question: string): Promise<boolean> {
	const answer = prompt(`${question} [y/N]`);
	return answer !== null && /^y(es)?$/i.test(answer.trim());
}

export const installCommand: Command = {
	name: "install",
	summary:
		"install warden to ~/.local/bin + hooks for detected agents (Claude Code: skill, hooks, argent rule; Codex: hooks)",
	usage: USAGE,
	run: (ctx) =>
		runInstall(ctx, {
			runtime: detectRuntime(),
			interactive: process.stdin.isTTY === true,
			confirm: confirmPrompt,
		}),
};
