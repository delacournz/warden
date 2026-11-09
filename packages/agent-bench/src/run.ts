import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installApp, terminateApp } from "@delacour/warden-e2e-bench/src/harness/app";
import {
	type BenchApp,
	benchAppDir,
	readBenchApp,
	verifyBenchApp,
} from "@delacour/warden-e2e-bench/src/harness/bench-app";
import { BUNDLE_ID } from "@delacour/warden-e2e-bench/src/harness/bundle";
import {
	type ClaimedDevice,
	claimDevice,
	heartbeatDevice,
	releaseDevice,
} from "@delacour/warden-e2e-bench/src/harness/device";
import type { Exec, ExecOptions } from "@delacour/warden-e2e-bench/src/harness/exec";
import { writeFileAtomic } from "@delacour/warden-e2e-bench/src/results/write";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { runChecks } from "./check";
import { type AgentReport, diffBaseline, type Outcome, REPORT_FILE, REPORT_MD, renderMarkdown } from "./report";
import { authEnv, createSandbox } from "./sandbox";
import { createStreamParser, type StreamMetrics } from "./stream";
import { type LoadedSuite, renderPrompt } from "./suite";

export const TRANSCRIPT_FILE = "transcript.ndjson";
export const STDERR_FILE = "claude-stderr.log";
const HEARTBEAT_MS = 60_000;
const STDERR_TAIL_LINES = 20;

export type RunInput = {
	loaded: LoadedSuite;
	repoRoot: string;
	/** a device the caller already leased; the agent then runs under the caller's warden session */
	udid?: string;
	/** override the suite's model */
	model?: string;
	/** override `<repoRoot>/.bench/<runId>` */
	outDir?: string;
};

export type RunDeps = {
	exec: Exec;
	env: Record<string, string | undefined>;
	now: () => Date;
	log: (line: string) => void;
	bunPath: string;
	heartbeatMs?: number;
	/** stops the agent's process group at the turn limit (default `process.kill(-pid)`) */
	kill?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
	/** Ctrl-C: stops the agent; the checks, the report and the release still run */
	signal?: AbortSignal;
};

export type RunOutput = { report: AgentReport; runDir: string };

/** `agent-<suite>-20261109T101500Z` */
export function runIdFor(suite: string, at: Date): string {
	return `agent-${suite}-${at
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d+Z$/, "Z")}`;
}

/** The warden session a caller-leased device belongs to (the agent must run as that session to drive it). */
function callerSession(env: Record<string, string | undefined>): string | undefined {
	return env.WARDEN_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || undefined;
}

/** `exec` with `env` merged under every call's own env (the bench's claim must carry the agent's session id). */
function withEnv(exec: Exec, env: Record<string, string | undefined>): Exec {
	const merge = <T extends Pick<ExecOptions, "env">>(o: T | undefined): T =>
		({ ...(o ?? {}), env: { ...env, ...(o?.env ?? {}) } }) as T;
	return {
		run: (cmd, args, options) => exec.run(cmd, args, merge(options)),
		start: (cmd, args, options) => exec.start(cmd, args, merge(options)),
		which: (cmd) => exec.which(cmd),
	};
}

/** `claude -p` argv: stream-json, the suite's model and tools, nothing from the user's own setup. */
export function claudeArgs(prompt: string, suite: LoadedSuite["suite"], model: string): string[] {
	return [
		"-p",
		prompt,
		"--output-format",
		"stream-json",
		"--verbose",
		"--model",
		model,
		"--allowedTools",
		...suite.allowedTools,
		"--permission-mode",
		"dontAsk",
		"--strict-mcp-config",
		"--setting-sources",
		"user",
		...(suite.maxBudgetUsd !== undefined ? ["--max-budget-usd", String(suite.maxBudgetUsd)] : []),
	];
}

type AgentRun = {
	exitCode: number;
	stopped?: "turn_limit" | "timed_out" | "aborted";
	stderrTail: string;
	wallMs: number;
};

/** Everything that can fail before a device is touched: credentials, claude, the pinned app. */
function preflight(input: RunInput, deps: RunDeps): Result<BenchApp> {
	const auth = authEnv(deps.env);
	if (!auth.success) return auth;
	if (deps.exec.which("claude") === undefined) return err("claude not found on PATH (install Claude Code)");
	const app = readBenchApp(benchAppDir(input.repoRoot, input.loaded.suite.platform));
	if (!app.success) return app;
	const verified = verifyBenchApp(app.data);
	return verified.success ? app : verified;
}

/** The warden session the agent runs as: the bench's own, or the caller's for a caller-leased `--udid`. */
function sessionFor(input: RunInput, env: RunDeps["env"], runId: string): Result<string> {
	if (input.udid === undefined) return ok(`agent-bench-${runId}`);
	const outer = callerSession(env);
	return outer === undefined
		? err("--udid needs WARDEN_SESSION_ID (the session that holds the lease) so the agent can drive it")
		: ok(outer);
}

/** The run's outcome: a stop by the bench wins, then an agent failure, then the checks. */
export function outcomeOf(agent: AgentRun, metrics: StreamMetrics, checksPassed: boolean): Outcome {
	if (agent.stopped !== undefined) return agent.stopped;
	if (agent.exitCode !== 0 || metrics.result === undefined || metrics.result.isError) return "agent_error";
	return checksPassed ? "passed" : "failed";
}

type DriveContext = {
	input: RunInput;
	deps: RunDeps;
	exec: Exec;
	app: BenchApp;
	runDir: string;
	cliPath: string;
	session: string;
	udid: string;
	model: string;
};

type Driven = { agent: AgentRun; metrics: StreamMetrics; checks: Awaited<ReturnType<typeof runChecks>> };

/** Installs the app, runs the agent in its sandbox, then the success checks; closes the agent's helper. */
async function drive(ctx: DriveContext): AsyncResult<Driven> {
	const { suite, promptTemplate } = ctx.input.loaded;
	await terminateApp(ctx.exec, suite.platform, ctx.udid, BUNDLE_ID);
	const installed = await installApp(ctx.exec, suite.platform, ctx.udid, ctx.app.appPath);
	if (!installed.success) return installed;
	const sandbox = createSandbox({
		root: join(ctx.runDir, "sandbox"),
		skillDir: join(ctx.input.repoRoot, "skills", "warden"),
		cliPath: ctx.cliPath,
		bunPath: ctx.deps.bunPath,
	});
	const prompt = renderPrompt(promptTemplate, { udid: ctx.udid, platform: suite.platform, bundleId: BUNDLE_ID });
	writeFileSync(join(ctx.runDir, "prompt.md"), prompt);
	const parser = createStreamParser(suite.failurePatterns);
	const transcript = join(ctx.runDir, TRANSCRIPT_FILE);
	writeFileSync(transcript, "");
	const agent = await runAgent(ctx.deps, {
		args: claudeArgs(prompt, suite, ctx.model),
		cwd: sandbox.workDir,
		env: sandbox.env(ctx.deps.env, ctx.session),
		maxTurns: suite.maxTurns,
		timeoutMs: suite.timeoutMs,
		onStdout: (line) => {
			appendFileSync(transcript, `${line}\n`);
			parser.push(line);
		},
		onTurn: (listener) => parser.onTurn(listener),
		stderrPath: join(ctx.runDir, STDERR_FILE),
	});
	ctx.deps.log(`agent finished: exit ${agent.exitCode}${agent.stopped ? ` (${agent.stopped})` : ""}`);
	const env = { WARDEN_SESSION_ID: ctx.session };
	const checks = await runChecks(ctx.deps.exec, {
		checks: suite.success,
		udid: ctx.udid,
		bunPath: ctx.deps.bunPath,
		cliPath: ctx.cliPath,
		env,
	});
	// the agent's helper (warden-simd / android host) for this device; the lease is released by the caller
	await ctx.deps.exec.run(ctx.deps.bunPath, [ctx.cliPath, "ui", "close", "--udid", ctx.udid], {
		env,
		timeoutMs: 30_000,
	});
	return ok({ agent, metrics: parser.metrics(), checks });
}

type ReportInput = { runId: string; startedAt: Date; model: string; udid: string; driven: Driven };

export function buildReport(suite: LoadedSuite["suite"], r: ReportInput): AgentReport {
	const { agent, metrics, checks } = r.driven;
	const outcome = outcomeOf(agent, metrics, checks.passed);
	const diff = diffBaseline(suite.baseline, metrics, agent.wallMs);
	return {
		reportVersion: 1,
		runId: r.runId,
		suite: suite.name,
		model: r.model,
		platform: suite.platform,
		udid: r.udid,
		startedAt: r.startedAt.toISOString(),
		wallMs: agent.wallMs,
		outcome,
		exitCode: agent.exitCode,
		metrics,
		checks: checks.results,
		...(diff !== undefined ? { diff } : {}),
		...(outcome === "agent_error" && agent.stderrTail !== "" ? { stderrTail: agent.stderrTail } : {}),
	};
}

/**
 * Claims (or reuses) a device, installs the pinned app, runs the agent in a sandbox, runs the success checks,
 * writes `report.json` / `report.md` / the transcript, and releases exactly the lease it claimed.
 */
export async function runAgentBench(input: RunInput, deps: RunDeps): AsyncResult<RunOutput> {
	const { suite } = input.loaded;
	const model = input.model ?? suite.model;
	const app = preflight(input, deps);
	if (!app.success) return app;
	const startedAt = deps.now();
	const runId = runIdFor(suite.name, startedAt);
	const session = sessionFor(input, deps.env, runId);
	if (!session.success) return session;
	const runDir = input.outDir ?? join(input.repoRoot, ".bench", runId);
	mkdirSync(runDir, { recursive: true });
	const cliPath = join(input.repoRoot, "apps", "cli", "src", "cli.ts");
	const exec = withEnv(deps.exec, { WARDEN_SESSION_ID: session.data });

	const claimed = await claimDevice(exec, {
		platform: suite.platform,
		cliPath,
		repoRoot: input.repoRoot,
		...(input.udid !== undefined ? { udid: input.udid } : {}),
		log: deps.log,
	});
	if (!claimed.success) return claimed;
	const device: ClaimedDevice = claimed.data;
	deps.log(`device ${device.udid}${device.leaseId ? ` (lease ${device.leaseId})` : ""}`);
	const heartbeat =
		device.leaseId === undefined
			? undefined
			: setInterval(() => {
					void heartbeatDevice(exec, { cliPath, leaseId: device.leaseId ?? "", repoRoot: input.repoRoot });
				}, deps.heartbeatMs ?? HEARTBEAT_MS);

	try {
		const driven = await drive({
			input,
			deps,
			exec,
			app: app.data,
			runDir,
			cliPath,
			session: session.data,
			udid: device.udid,
			model,
		});
		if (!driven.success) return driven;
		const report = buildReport(suite, { runId, startedAt, model, udid: device.udid, driven: driven.data });
		writeFileAtomic(join(runDir, REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`);
		writeFileAtomic(join(runDir, REPORT_MD), renderMarkdown(report));
		return ok({ report, runDir });
	} finally {
		if (heartbeat !== undefined) clearInterval(heartbeat);
		if (device.leaseId !== undefined) {
			const released = await releaseDevice(exec, { cliPath, leaseId: device.leaseId, repoRoot: input.repoRoot });
			deps.log(released.success ? `released ${device.leaseId}` : `release failed: ${String(released.error)}`);
		}
	}
}

type AgentInput = {
	args: string[];
	cwd: string;
	env: Record<string, string | undefined>;
	maxTurns: number;
	timeoutMs: number;
	onStdout: (line: string) => void;
	onTurn: (listener: (turns: number) => void) => void;
	stderrPath: string;
};

/** Signals a process group (the agent leads its own: `exec.run` with a timeout spawns it detached). */
export function killGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
	try {
		process.kill(-pid, signal);
	} catch {
		// already gone
	}
}

/**
 * Runs `claude` to completion (all output drained, so the final `result` event is never cut off), stopping it
 * past `maxTurns` assistant messages; `timeoutMs` is the exec's own group kill.
 */
async function runAgent(deps: RunDeps, input: AgentInput): Promise<AgentRun> {
	const stderr: string[] = [];
	writeFileSync(input.stderrPath, "");
	let pid: number | undefined;
	let stoppedBy: "turn_limit" | "aborted" | undefined;
	const stop = (why: "turn_limit" | "aborted", message: string): void => {
		if (stoppedBy !== undefined) return;
		stoppedBy = why;
		deps.log(`stopping the agent: ${message}`);
		if (pid !== undefined) (deps.kill ?? killGroup)(pid, "SIGTERM");
	};
	input.onTurn((turns) => {
		if (turns > input.maxTurns) stop("turn_limit", `more than ${input.maxTurns} turns`);
	});
	const onAbort = (): void => stop("aborted", "interrupted");
	if (deps.signal?.aborted) onAbort();
	deps.signal?.addEventListener("abort", onAbort, { once: true });
	const ran = await deps.exec.run("claude", input.args, {
		cwd: input.cwd,
		env: input.env,
		timeoutMs: input.timeoutMs,
		onSpawn: (p) => {
			pid = p;
		},
		onLine: (stream, line) => {
			if (stream === "stdout") input.onStdout(line);
			else {
				stderr.push(line);
				appendFileSync(input.stderrPath, `${line}\n`);
			}
		},
	});
	deps.signal?.removeEventListener("abort", onAbort);
	if (ran.spawnError !== undefined) stderr.push(`spawn: ${ran.spawnError}`);
	const stopped = stoppedBy ?? (ran.timedOut ? "timed_out" : undefined);
	return {
		exitCode: ran.code,
		...(stopped !== undefined ? { stopped } : {}),
		stderrTail: stderr.slice(-STDERR_TAIL_LINES).join("\n"),
		wallMs: Math.round(ran.durationMs),
	};
}
