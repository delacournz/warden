#!/usr/bin/env bun
/**
 * Run this repo's CI checks locally, then sign off the PR with `gh signoff`.
 *
 *   bun run signoff              # plan, run, sign off, post the report
 *   bun run signoff -- --dry-run # print the plan and stop
 *   bun run signoff -- --concurrency 1       # one check at a time (default 3)
 *
 * Why this exists: every check here had already run on the machine that authored the change —
 * through prek, through `bun test`, or through the agent that wrote it — and then ran a second time
 * on billed macOS runners. So `ci.yml` became `workflow_dispatch`-only and the gate moved to a commit
 * status written from here.
 *
 * The gate is not weaker for being local. `basecamp/gh-signoff` writes
 * `POST /repos/:owner/:repo/statuses/<sha>` with `context: signoff[/<check>]`, and `main`'s branch
 * protection (`gh signoff install`) requires the umbrella — see `REQUIRED_CONTEXTS` in
 * ./signoff-checks.ts and AGENTS.md § Signoff. Statuses bind to a SHA, so pushing another commit
 * (or pressing **Update branch**) drops the signoff and this has to run again. Which checks are
 * relevant comes from the diff, not from a promise: `planChecks` reads the path gates, and the
 * umbrella `signoff` context — the one that actually unblocks the merge — is withheld unless every
 * check the diff made applicable passed. `--only` / `--skip` runs write the sub-contexts that passed
 * and never the umbrella: a partial run is not a signoff.
 *
 * Provenance is the other half. GitHub records the status creator and stamps
 * `"<login> signed off"` on each context, and this posts a report comment naming the actor, the
 * runner (an agent, a shell, or a dispatched workflow), the SHA, every check's duration, and every
 * skipped check's reason. An agent signing off is therefore visible as an agent, and a signoff that
 * quietly skipped a suite says so in writing.
 *
 * A check's duration breaks down per command and, for the turbo-backed ones, per turbo task — read
 * from the run summary `--summarize` writes, so a slow check names the workspace responsible rather
 * than only a total. Tasks turbo replayed from cache are labelled as replays rather than counted as
 * fast work, for the same reason the rest of this file refuses to let a hollow pass read as a real
 * one.
 *
 * Break-glass: bare `gh signoff` writes the contexts without running anything. It exists for the
 * case where a laptop genuinely cannot run a suite — but the honest escape hatch is dispatching the
 * workflow with `-f signoff-sha=<sha>`, which runs the real thing and signs off from CI.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { applyFilters, type PlannedCheck, planChecks, type SignoffCommand } from "./signoff-checks";
import { runPool } from "./signoff-pool";

/** Every check runs from here, whatever directory `bun run signoff` was typed in. */
const REPO_ROOT = join(import.meta.dir, "../..");

/** One turbo task, as the `--summarize` run summary reports it. */
export type TurboTaskTiming = {
	/** `<package>#<task>`, e.g. `@delacour/splitpush#build`. */
	taskId: string;
	durationMs: number;
	/** Replayed from cache rather than executed — near-zero time, and no evidence the work ran. */
	cached: boolean;
};

/** One spawned command's timing, plus the turbo tasks it ran when it was a turbo command. */
export type CommandTiming = {
	/** The command as spawned, shortened for the report table. */
	label: string;
	durationMs: number;
	/** Slowest first. Empty for a command that writes no run summary (cargo, playwright, git). */
	tasks: readonly TurboTaskTiming[];
};

export type CheckOutcome =
	| {
			context: string;
			label: string;
			status: "passed" | "failed";
			durationMs: number;
			/** Something that qualifies a pass — an env var that turned a suite off, say. */
			note?: string;
			/** Per-command breakdown, so a slow check names the command and the workspace responsible. */
			timings?: readonly CommandTiming[];
	  }
	| {
			context: string;
			label: string;
			status: "skipped";
			reason: string;
			/** Excluded by `--only` / `--skip` although the diff needed it. */
			filtered: boolean;
	  };

/**
 * Who ran the checks, as opposed to whose token wrote the status. The two differ constantly here:
 * an agent in a worktree signs off with the human's `gh` credentials, and without this line the PR
 * would read as though a person sat and watched the suite.
 */
export function describeRunner(env: Record<string, string | undefined>): string {
	if (env.GITHUB_ACTIONS === "true") {
		return `GitHub Actions (${env.GITHUB_WORKFLOW ?? "dispatched workflow"})`;
	}
	if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return "Claude Code";
	return "human (interactive shell)";
}

/**
 * The umbrella context is earned only when something ran, nothing failed, and no check the diff
 * needed was filtered out. "Something ran" is not pedantry: a plan that skipped everything (a check
 * filter typo, say) would otherwise sign off a PR nobody verified. The filter rule matters because
 * only the umbrella is required: without it `--skip test` would be a way to merge without tests.
 */
export function umbrellaEarned(outcomes: readonly CheckOutcome[]): boolean {
	return (
		outcomes.some((outcome) => outcome.status === "passed") &&
		!outcomes.some((outcome) => outcome.status === "failed" || (outcome.status === "skipped" && outcome.filtered))
	);
}

/** Why the umbrella was withheld, for the report heading and the exit message. */
function withheldBecause(outcomes: readonly CheckOutcome[]): string {
	if (outcomes.some((outcome) => outcome.status === "failed")) return "Checks failed";
	return "Partial run";
}

/**
 * gh-signoff's own subcommands. Any context sharing one of these names is a trap, because the
 * context is passed positionally and the command word is also positional.
 */
export const GH_SIGNOFF_SUBCOMMANDS = [
	"create",
	"install",
	"uninstall",
	"check",
	"status",
	"version",
	"completion",
] as const;

/**
 * The `gh signoff` argv that writes one context's status — or the umbrella, when `context` is null.
 *
 * `create` is named explicitly rather than leaning on it being the default command. `check` is both
 * one of our required contexts and one of gh-signoff's subcommands, so `gh signoff check --commit
 * <sha>` is parsed as the subcommand, which rejects `--commit` and writes nothing at all. `create`
 * takes every non-option argument as a context, so no context name can collide.
 */
export function signoffArgv(sha: string, context: string | null): string[] {
	return ["gh", "signoff", "create", ...(context === null ? [] : [context]), "--commit", sha];
}

export function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * The turbo task a command runs, or null when it is not a turbo command at all.
 *
 * This is what decides where `--summarize` is appended, so it is deliberately narrow: `turbo` has to
 * be the command word or `bunx`'s first argument. `cargo test -p turbo` names a package, not a task,
 * and appending a turbo flag to it would break a check rather than instrument one.
 */
export function turboTaskName(argv: readonly string[]): string | null {
	const index = argv.indexOf("turbo");
	if (index === -1 || index > 1) return null;
	for (const arg of argv.slice(index + 1)) {
		if (arg === "run") continue;
		return arg.startsWith("-") ? null : arg;
	}
	return null;
}

/** A command's argv as one short cell, pipes escaped so it cannot split the report's table row. */
export function commandLabel(argv: readonly string[], limit = 48): string {
	const text = argv.join(" ").replaceAll("|", "\\|");
	return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The tasks a `turbo --summarize` run recorded, slowest first.
 *
 * Null means the payload was not a run summary — a truncated file, a shape turbo changed under us.
 * An empty array means it *was* one and matched no task, which is a different fact and reported as
 * such. Everything here narrows from `unknown`: this reads a file written by another program, and a
 * summary that stopped parsing must never be able to change a check's verdict.
 */
export function parseTurboSummary(raw: unknown): TurboTaskTiming[] | null {
	if (!isRecord(raw) || !Array.isArray(raw.tasks)) return null;
	const tasks: TurboTaskTiming[] = [];
	for (const entry of raw.tasks) {
		if (!isRecord(entry) || typeof entry.taskId !== "string") continue;
		const execution = isRecord(entry.execution) ? entry.execution : null;
		const start = finiteNumber(execution?.startTime);
		const end = finiteNumber(execution?.endTime);
		if (start === null || end === null) continue;
		const cache = isRecord(entry.cache) ? entry.cache : null;
		tasks.push({ taskId: entry.taskId, durationMs: Math.max(0, end - start), cached: cache?.status === "HIT" });
	}
	return tasks.sort((a, b) => b.durationMs - a.durationMs);
}

/**
 * The detail cell's breakdown: which command, and which workspace inside it, the time went to.
 *
 * The gap this closes: `build 5m 10s` was the entire report for a run in which one workspace
 * (`@delacour/splitpush#build`) hung for 5m 10s and the other eleven finished in six seconds
 * between them. The total was accurate and told you nothing actionable.
 *
 * Cache hits are called out rather than averaged in, for the same reason the rest of this file
 * qualifies a hollow pass: a `check` that replayed all 29 tasks from cache took two seconds and
 * verified nothing, and a bare "2s" reads like the opposite of that.
 */
export function describeTiming(timings: readonly CommandTiming[]): string | undefined {
	const parts: string[] = [];
	if (timings.length > 1) {
		parts.push(timings.map((timing) => `\`${timing.label}\` ${formatDuration(timing.durationMs)}`).join(" · "));
	}
	const tasks = timings.flatMap((timing) => [...timing.tasks]).sort((a, b) => b.durationMs - a.durationMs);
	const plural = tasks.length === 1 ? "" : "s";
	const cached = tasks.filter((task) => task.cached).length;
	if (tasks.length > 0 && cached === tasks.length) {
		parts.push(`all ${tasks.length} task${plural} replayed from cache`);
	} else if (tasks.length > 0) {
		const slowest = tasks[0];
		const suffix = cached > 0 ? `, ${cached} cached` : "";
		parts.push(
			`${tasks.length} task${plural}${suffix} — slowest \`${slowest?.taskId}\` ${formatDuration(slowest?.durationMs ?? 0)}`
		);
	}
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

const REPORT_MARKER = "<!-- signoff-report -->";

/**
 * The PR comment. Keyed by `REPORT_MARKER` so a re-run edits it in place — a PR that is pushed to
 * five times should carry one current report, not five stale ones.
 */
export function renderReport(input: {
	sha: string;
	actor: string;
	runner: string;
	when: string;
	outcomes: readonly CheckOutcome[];
}): string {
	const earned = umbrellaEarned(input.outcomes);
	const rows = input.outcomes.map((outcome) => {
		if (outcome.status === "skipped") return `| ${outcome.label} | — skipped | ${outcome.reason} |`;
		const mark = outcome.status === "passed" ? "✓" : "✗";
		const breakdown = describeTiming(outcome.timings ?? []);
		return `| ${outcome.label} | ${mark} | ${[formatDuration(outcome.durationMs), breakdown, outcome.note].filter(Boolean).join(" — ")} |`;
	});
	const heading = earned ? "✅ Signed off" : `❌ ${withheldBecause(input.outcomes)} — **not signed off**`;

	return [
		REPORT_MARKER,
		`### ${heading} — \`${input.sha.slice(0, 7)}\``,
		"",
		`Ran by **@${input.actor}** · ${input.runner} · ${input.when}`,
		"",
		"| check | result | detail |",
		"|---|---|---|",
		...rows,
		"",
		earned
			? "_Statuses are bound to this commit. Push again and the signoff drops — re-run `bun run signoff`._"
			: "_No `signoff` context was written. Fix the failures (or drop `--only` / `--skip`) and re-run `bun run signoff`._",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Everything below is the CLI: process spawning, git and gh. Untested by design —
// the logic worth pinning is exported above.
// ---------------------------------------------------------------------------

/**
 * The env every check runs under: this process's, minus everything the root `.env.local` defines.
 *
 * **Signoff exists to reproduce CI on this machine, and CI has no `.env.local`.** Bun auto-loads
 * that file for `bun run signoff`, and turbo then hands the result to every task — so a suite that
 * asserts on the *absence* of some config would see it present and fail, green or red depending
 * only on which directory the command was typed in. Stripping by key rather than by an allowlist
 * keeps this correct as the file grows: a variable added tomorrow is stripped tomorrow.
 */
async function ciLikeEnv(): Promise<Record<string, string | undefined>> {
	const env: Record<string, string | undefined> = { ...process.env };
	const file = Bun.file(join(REPO_ROOT, ".env.local"));
	if (!(await file.exists())) return env;
	for (const line of (await file.text()).split("\n")) {
		const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
		if (key) delete env[key];
	}
	return env;
}

/** Resolved once: reading and parsing the file per spawned command would be pointless churn. */
const checkEnv = await ciLikeEnv();

/**
 * Run a command; returns its exit code. With no `sink` the user's stdio is attached. With one, stdout
 * and stderr are collected into it instead — how parallel checks keep their logs from interleaving.
 */
async function spawn(command: SignoffCommand, sink: string[] | null = null): Promise<number> {
	if (sink === null) {
		const child = Bun.spawn([...command.argv], {
			cwd: join(REPO_ROOT, command.cwd ?? "."),
			env: checkEnv,
			stdio: ["inherit", "inherit", "inherit"],
		});
		return await child.exited;
	}
	const child = Bun.spawn([...command.argv], {
		cwd: join(REPO_ROOT, command.cwd ?? "."),
		env: checkEnv,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const drain = async (stream: ReadableStream<Uint8Array>) => {
		const decoder = new TextDecoder();
		for await (const chunk of stream) sink.push(decoder.decode(chunk, { stream: true }));
	};
	const [code] = await Promise.all([child.exited, drain(child.stdout), drain(child.stderr)]);
	return code;
}

/**
 * Where `turbo --summarize` drops its run summaries. Always the repo root, whatever a check's `cwd`
 * is, and gitignored — nothing here writes into the tree being signed off.
 */
const TURBO_RUNS_DIR = join(REPO_ROOT, ".turbo/runs");

function summaryFilenames(): Set<string> {
	try {
		return new Set(readdirSync(TURBO_RUNS_DIR));
	} catch {
		// No directory until the first --summarize run; an unreadable one is equally not our business.
		return new Set();
	}
}

/** Whether a summary payload came from `turbo run <task>` rather than some other turbo invocation. */
function ranTurboTask(raw: unknown, task: string): boolean {
	if (!isRecord(raw) || !isRecord(raw.execution)) return true;
	const command = raw.execution.command;
	return typeof command === "string" ? command.split(/\s+/).includes(task) : true;
}

/**
 * The tasks the summary this command just wrote reports, or an empty list if there is nothing
 * trustworthy to read.
 *
 * Identified by *appearance* — the filenames present before the spawn, diffed against after — rather
 * than by mtime, so no clock granularity or skew can make a stale summary look fresh. `.turbo/runs/`
 * is never pruned, so by the fourth check of a run there are dozens of old files in there and
 * "newest" alone is a guess. `ranTurboTask` is the tiebreak for the one case the diff cannot rule
 * out: a sibling worktree's agent running its own turbo against this same repo root mid-check.
 *
 * Every failure path here returns empty. Instrumentation that could throw would be instrumentation
 * that can fail a check the checks themselves passed.
 */
async function readNewSummary(before: ReadonlySet<string>, task: string): Promise<TurboTaskTiming[]> {
	let candidates: string[] = [];
	try {
		candidates = readdirSync(TURBO_RUNS_DIR).filter((name) => name.endsWith(".json") && !before.has(name));
	} catch {
		return [];
	}
	let best: SummaryRead | null = null;
	for (const name of candidates) {
		const summary = await readSummaryFile(`${TURBO_RUNS_DIR}/${name}`, task);
		if (summary !== null && (best === null || summary.endTime > best.endTime)) best = summary;
	}
	return best?.tasks ?? [];
}

type SummaryRead = { endTime: number; tasks: TurboTaskTiming[] };

/** One candidate summary, or null when it is unreadable, malformed, or some other run's. */
async function readSummaryFile(path: string, task: string): Promise<SummaryRead | null> {
	try {
		const raw: unknown = await Bun.file(path).json();
		if (!ranTurboTask(raw, task)) return null;
		const tasks = parseTurboSummary(raw);
		if (tasks === null) return null;
		const execution = isRecord(raw) && isRecord(raw.execution) ? raw.execution : null;
		return { endTime: finiteNumber(execution?.endTime) ?? 0, tasks };
	} catch {
		// A half-written or unreadable summary is not evidence about this check either way.
		return null;
	}
}

/**
 * Run one check's commands in order, stopping at the first failure, and time each one.
 *
 * `--summarize` is appended here rather than baked into the check definition: the definition is the
 * contract with CI, and how this runner observes it is not part of that. It only writes a JSON file,
 * so it cannot change what a check decides — and the summary is read even when the command failed,
 * because the slowest task of a failed build is exactly the thing you want named.
 */
async function runCheck(
	commands: readonly SignoffCommand[],
	sink: string[] | null
): Promise<{ code: number; timings: CommandTiming[] }> {
	const timings: CommandTiming[] = [];
	let code = 0;
	for (const command of commands) {
		const task = turboTaskName(command.argv);
		const before = task === null ? new Set<string>() : summaryFilenames();
		const started = Bun.nanoseconds();
		code = await spawn(task === null ? command : { ...command, argv: [...command.argv, "--summarize"] }, sink);
		const durationMs = (Bun.nanoseconds() - started) / 1e6;
		timings.push({
			label: commandLabel(command.argv),
			durationMs,
			tasks: task === null ? [] : await readNewSummary(before, task),
		});
		if (code !== 0) break;
	}
	return { code, timings };
}

/** Run a command for its stdout. Returns null when it fails, so callers can branch on absence. */
async function capture(argv: readonly string[]): Promise<string | null> {
	return (await captureWithError(argv)).stdout;
}

/**
 * The last stderr `captureWithError` saw, so a caller that only branches on `null` can still say
 * *why*. Module-level rather than threaded through every call site: the alternative is changing
 * every `capture` signature to report an error almost none of them can act on.
 */
let lastCaptureError = "";

/** GitHub's own transient failures. A 5xx is the API being unwell, not an answer about this PR. */
const TRANSIENT_GH_ERROR = /HTTP (429|5\d\d)|rate limit|timeout|EAI_AGAIN|ECONNRESET|no server is currently available/i;

/**
 * `capture`, plus the stderr and one retry per transient failure.
 *
 * **A GitHub 5xx must not read as an answer.** `gh` exits non-zero for "no PR exists" and for "the
 * GraphQL API is down" alike, and `capture` flattens both to `null` — so during a GitHub outage the
 * PR lookup returned nothing and signoff aborted with *"no open PR for this branch. Open one first"*
 * against a branch whose PR was open the whole time. That message sends you off to fix something
 * that was never broken, which is worse than no message.
 *
 * Retries are deliberately patient rather than few. Every `gh` call here is sub-second and there is
 * a handful of them per run, so waiting costs nothing next to re-running twenty minutes of checks
 * because the API blinked — and a real outage is **bursty**, not uniformly random, so three quick
 * attempts can all land inside the same bad second. Measured against a live GitHub incident on
 * 2026-08-17: roughly one call in five failed, yet three consecutive attempts still lost.
 */
async function captureWithError(
	argv: readonly string[],
	attempts = 5
): Promise<{ stdout: string | null; stderr: string }> {
	let stderr = "";
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
		const [stdout, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
		if ((await child.exited) === 0) {
			lastCaptureError = "";
			return { stdout: stdout.trim(), stderr: error.trim() };
		}
		stderr = error.trim();
		if (attempt === attempts || !TRANSIENT_GH_ERROR.test(stderr)) break;
		console.log(`  … ${argv[0]} failed transiently, retrying (${attempt}/${attempts - 1}): ${firstLine(stderr)}`);
		await Bun.sleep(attempt * 2000);
	}
	lastCaptureError = stderr;
	return { stdout: null, stderr };
}

function firstLine(text: string): string {
	return text.split("\n")[0]?.trim() ?? "";
}

/**
 * Write one commit status, retrying a transient GitHub failure.
 *
 * This is the **expensive** call to lose. It runs after every check has passed, so a 503 here
 * throws away the whole run's evidence and leaves the PR blocked on a status that was earned. The
 * plain `spawn` used before had no retry at all, and its stdio was inherited — so the failure was
 * a bare non-zero exit with the cause scrolling past among the check output.
 *
 * Output is captured rather than inherited so the transient test can see it; `gh signoff` is quiet
 * on success, and on a real failure the stderr is printed here instead.
 */
async function writeStatus(argv: readonly string[]): Promise<number> {
	const { stdout, stderr } = await captureWithError(argv);
	if (stdout !== null) return 0;
	if (stderr) console.error(`  ${firstLine(stderr)}`);
	return 1;
}

/** Appends whatever the failed command actually said, when it said anything. */
function withCause(message: string): string {
	const cause = firstLine(lastCaptureError);
	return cause ? `${message}\n  ↳ ${cause}` : message;
}

function fail(message: string): never {
	console.error(`\n✗ ${message}`);
	process.exit(1);
}

type Args = {
	dryRun: boolean;
	only: string[];
	skip: string[];
	comment: boolean;
	base: string | null;
	/** How many checks run at once; 1 is the old strictly-serial, live-output run. */
	concurrency: number;
};

/** The valueless flags, as setters — a table rather than more `else if` arms. */
const BOOLEAN_FLAGS = new Map<string, (args: Args) => void>([
	[
		"--dry-run",
		(args) => {
			args.dryRun = true;
		},
	],
	[
		"--no-comment",
		(args) => {
			args.comment = false;
		},
	],
]);

/**
 * Checks run three at a time by default. Each is an independent turbo run, and each is itself
 * parallel, so past three a laptop spends its time on CPU contention rather than on the diff.
 */
const DEFAULT_CONCURRENCY = 3;

function parseConcurrency(raw: string | undefined): number {
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) fail(`--concurrency needs a whole number ≥ 1, got ${raw}`);
	return value;
}

/** The flags that take a value, as setters — same reason as `BOOLEAN_FLAGS`. */
const VALUE_FLAGS = new Map<string, (args: Args, value: string | undefined) => void>([
	["--only", (args, value) => args.only.push(...(value ?? "").split(","))],
	["--skip", (args, value) => args.skip.push(...(value ?? "").split(","))],
	[
		"--base",
		(args, value) => {
			args.base = value ?? null;
		},
	],
	[
		"--concurrency",
		(args, value) => {
			args.concurrency = parseConcurrency(value);
		},
	],
]);

function parseArgs(argv: readonly string[]): Args {
	const args: Args = {
		dryRun: false,
		only: [],
		skip: [],
		comment: true,
		base: null,
		concurrency: DEFAULT_CONCURRENCY,
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		const flag = arg === undefined ? undefined : BOOLEAN_FLAGS.get(arg);
		const valued = arg === undefined ? undefined : VALUE_FLAGS.get(arg);
		if (flag) flag(args);
		else if (valued) valued(args, argv[++index]);
		else {
			console.error(`unknown argument: ${arg}`);
			console.error(
				"usage: bun run signoff [--dry-run] [--only ctx,ctx] [--skip ctx,ctx] [--no-comment] [--base ref] [--concurrency n]"
			);
			process.exit(2);
		}
	}
	return args;
}

/**
 * The branch this work merges into: the PR's own base when there is one, `main` otherwise.
 */
async function resolveBase(explicit: string | null): Promise<string> {
	if (explicit) return explicit;
	const base = await capture(["gh", "pr", "view", "--json", "baseRefName", "--jq", ".baseRefName"]);
	return base || "main";
}

/**
 * Everything that must hold before a status may be written. Deliberately not run for `--dry-run`:
 * previewing the plan mid-change is the point of that flag, and it writes nothing.
 */
async function preflight(): Promise<{ sha: string; pr: { number: number; base: string }; actor: string }> {
	if (!(await capture(["git", "rev-parse", "--git-dir"]))) fail("not inside a git repository.");

	const dirty = await capture(["git", "status", "--porcelain"]);
	if (dirty === null) fail("`git status` failed.");
	if (dirty !== "") {
		fail(
			"the working tree is dirty. A signoff binds to a commit — verifying uncommitted work would " +
				"attest to something the PR does not contain. Commit or stash first."
		);
	}

	const sha = await capture(["git", "rev-parse", "HEAD"]);
	if (!sha) fail("could not resolve HEAD.");

	// gh-signoff refuses to write a status for a commit no remote has; check it here for a clearer message.
	if (!(await capture(["git", "rev-parse", "@{push}"]))) {
		fail("HEAD is not pushed (no upstream tracking commit). `git push` first — the status binds to a remote SHA.");
	}
	const remoteHead = await capture(["git", "rev-parse", "@{push}"]);
	if (remoteHead !== sha)
		fail(`HEAD (${sha.slice(0, 7)}) is ahead of its remote (${remoteHead?.slice(0, 7)}). Push first.`);

	const prJson = await capture(["gh", "pr", "view", "--json", "number,baseRefName,state"]);
	if (!prJson) {
		fail(
			withCause(
				"could not read this branch's PR. If the cause below is a 5xx or a rate limit, GitHub is " +
					"unwell rather than this branch — check githubstatus.com and re-run. Otherwise open a PR " +
					"first: the signoff report is posted to it."
			)
		);
	}
	const pr = JSON.parse(prJson) as { number: number; baseRefName: string; state: string };
	if (pr.state !== "OPEN") fail(`the PR for this branch is ${pr.state}, not OPEN.`);

	const actor = await capture(["gh", "api", "user", "--jq", ".login"]);
	if (!actor) fail(withCause("could not identify the `gh` user. If this is not an auth error, run `gh auth login`."));

	const extensions = await capture(["gh", "extension", "list"]);
	if (!extensions?.includes("gh-signoff")) {
		console.log("· installing the gh-signoff extension (one-off, per machine)…");
		if ((await spawn({ argv: ["gh", "extension", "install", "basecamp/gh-signoff"] })) !== 0) {
			fail("could not install basecamp/gh-signoff. Install it by hand, then re-run.");
		}
	}

	return { sha, pr: { number: pr.number, base: pr.baseRefName }, actor };
}

/**
 * The files this PR changes, against the merge base with its own target branch.
 *
 * `includeWorkingTree` is for `--dry-run` only: a real signoff runs on a clean tree, so committed
 * history IS the change, but previewing the plan mid-edit has to see the file you just wrote or it
 * answers a question about the wrong diff.
 */
async function changedFiles(base: string, includeWorkingTree = false): Promise<string[]> {
	await capture(["git", "fetch", "--quiet", "origin", base]);
	const mergeBase = (await capture(["git", "merge-base", `origin/${base}`, "HEAD"])) ?? `origin/${base}`;
	const diff = await capture(["git", "diff", "--name-only", mergeBase, ...(includeWorkingTree ? [] : ["HEAD"])]);
	if (diff === null) fail(`could not diff against origin/${base}.`);
	const untracked = includeWorkingTree
		? ((await capture(["git", "ls-files", "--others", "--exclude-standard"])) ?? "")
		: "";
	return [...diff.split("\n"), ...untracked.split("\n")].filter(Boolean);
}

/** One plan line: what runs, and why each skipped check was skipped. */
function planLine(entry: PlannedCheck): string {
	if (!entry.applicable) return `  skip  ${entry.check.label.padEnd(22)} ${entry.reason}`;
	return `  run   ${entry.check.label}`;
}

/** Post the report, or edit the existing one so re-runs don't stack comments. */
async function upsertReport(prNumber: number, body: string): Promise<void> {
	const existing = await capture([
		"gh",
		"api",
		`repos/{owner}/{repo}/issues/${prNumber}/comments`,
		"--paginate",
		"--jq",
		`[.[] | select(.body | startswith("${REPORT_MARKER}")) | .id] | last // empty`,
	]);
	const target = existing
		? [`repos/{owner}/{repo}/issues/comments/${existing}`, "--method", "PATCH"]
		: [`repos/{owner}/{repo}/issues/${prNumber}/comments`, "--method", "POST"];
	const child = Bun.spawn(["gh", "api", ...target, "-f", `body=${body}`], { stdout: "ignore", stderr: "inherit" });
	if ((await child.exited) !== 0)
		console.error("! could not post the signoff report comment (the statuses still stand).");
}

/**
 * Printed as a check ends rather than only in the report comment: this is what you are staring at
 * while a twenty-minute run is in progress, and the comment does not exist yet.
 */
function printSlowestTasks(timings: readonly CommandTiming[]): void {
	for (const task of timings
		.flatMap((timing) => [...timing.tasks])
		.sort((a, b) => b.durationMs - a.durationMs)
		.slice(0, 3)) {
		console.log(`  · ${task.taskId} ${formatDuration(task.durationMs)}${task.cached ? " (cached)" : ""}`);
	}
}

/**
 * One planned check, resolved to its outcome. Serial runs stream the check's output live; parallel
 * ones collect it and print it in one block when the check ends, so two suites never interleave.
 */
async function outcomeFor(entry: PlannedCheck, args: Args): Promise<CheckOutcome> {
	const { check } = entry;
	if (!entry.applicable) {
		return {
			context: check.context,
			label: check.label,
			status: "skipped",
			reason: entry.reason,
			filtered: entry.filtered,
		};
	}
	const sink: string[] | null = args.concurrency === 1 ? null : [];
	console.log(sink === null ? `\n━━ ${check.label} ━━` : `▶ ${check.label}`);
	const { code, timings } = await runCheck(check.run, sink);
	const durationMs = timings.reduce((total, timing) => total + timing.durationMs, 0);
	if (sink !== null) {
		console.log(`\n━━ ${check.label} ${code === 0 ? "✓" : "✗"} ${formatDuration(durationMs)} ━━`);
		process.stdout.write(sink.join(""));
	}
	printSlowestTasks(timings);
	return {
		context: check.context,
		label: check.label,
		status: code === 0 ? "passed" : "failed",
		durationMs,
		timings,
	};
}

if (import.meta.main) {
	const args = parseArgs(process.argv.slice(2));

	if (args.dryRun) {
		const base = await resolveBase(args.base);
		console.log(`\nsignoff plan — against origin/${base}\n`);
		for (const entry of applyFilters(planChecks(await changedFiles(base, true)), args)) {
			console.log(planLine(entry));
		}
		process.exit(0);
	}

	const { sha, pr, actor } = await preflight();
	const base = args.base ?? pr.base;

	const plan = applyFilters(planChecks(await changedFiles(base)), args);
	const applicable = plan.filter((entry) => entry.applicable);

	console.log(`\nsignoff — PR #${pr.number} → ${base}, HEAD ${sha.slice(0, 7)}\n`);
	for (const entry of plan) {
		console.log(planLine(entry));
	}
	if (applicable.length === 0) fail("nothing to run — no check is applicable, so there is nothing to sign off.");

	// Every applicable check goes through the pool; skipped ones resolve without running anything.
	// `runPool` returns in plan order, so the report reads the same however the checks interleaved.
	if (args.concurrency > 1) {
		console.log(`\nrunning up to ${args.concurrency} checks at once — output prints as each one ends\n`);
	}
	const outcomes: CheckOutcome[] = await runPool(
		plan.map((entry) => ({
			locks: entry.applicable ? (entry.check.locks ?? []) : [],
			run: () => outcomeFor(entry, args),
		})),
		args.concurrency
	);

	const earned = umbrellaEarned(outcomes);
	const failed = outcomes.filter((outcome) => outcome.status === "failed");
	/** Contexts whose check passed but whose status write failed — see the umbrella guard below. */
	const unwritten: string[] = [];

	// Sub-contexts first, umbrella last: if the process dies between them the PR is left visibly
	// half-signed rather than mergeable on an umbrella whose parts were never written.
	if (earned) {
		for (const outcome of outcomes.filter((o) => o.status === "passed")) {
			const code = await writeStatus(signoffArgv(sha, outcome.context));
			if (code !== 0) unwritten.push(outcome.context);
		}
		// The umbrella attests that every applicable check passed **and landed**. Writing it over a
		// failed sub-context write is what let this go unnoticed: the run exited 0, the panel showed
		// green, and the one required status that never arrived was simply not there.
		if (unwritten.length === 0) {
			await writeStatus(signoffArgv(sha, null));
		}
	}

	if (args.comment) {
		await upsertReport(
			pr.number,
			renderReport({
				sha,
				actor,
				runner: describeRunner(process.env),
				when: `${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC`,
				outcomes,
			})
		);
	}

	if (failed.length > 0) {
		fail(`${failed.length} check(s) failed: ${failed.map((o) => o.label).join(", ")}. No signoff written.`);
	}
	// Below the report on purpose: a run whose checks all passed but whose statuses did not land is
	// still worth a comment, and the comment is the only place the durations survive.
	if (unwritten.length > 0) {
		fail(`${unwritten.length} status(es) could not be written: ${unwritten.join(", ")}. Umbrella withheld.`);
	}
	if (!earned) {
		const filtered = outcomes.filter((o) => o.status === "skipped" && o.filtered).map((o) => o.label);
		fail(`${withheldBecause(outcomes).toLowerCase()} (${filtered.join(", ")} filtered out). Umbrella withheld.`);
	}
	console.log(`\n✓ signed off ${sha.slice(0, 7)} on PR #${pr.number}.`);
}
