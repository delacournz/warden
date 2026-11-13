import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunContext } from "@delacour/warden-e2e-bench/src/adapters/adapter.types";
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
import { type Exec, type ExecOptions, runOk } from "@delacour/warden-e2e-bench/src/harness/exec";
import { isolate } from "@delacour/warden-e2e-bench/src/harness/isolation";
import { killMatching } from "@delacour/warden-e2e-bench/src/harness/residue";
import { writeFileAtomic } from "@delacour/warden-e2e-bench/src/results/write";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { runChecks } from "./check";
import { defaultKitDeps, type Kit, type KitDeps, resolveKit, type ToolId } from "./kit";
import {
	type AgentReport,
	diffBaseline,
	type Outcome,
	type RanReport,
	REPORT_FILE,
	REPORT_MD,
	renderMarkdown,
	type ToolReport,
} from "./report";
import { authEnv, createSandbox } from "./sandbox";
import { createStreamParser, type StreamMetrics } from "./stream";
import { composePrompt, type LoadedSuite } from "./suite";

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
	/** narrow the suite's tools (kept in the suite's order) */
	tools?: readonly ToolId[];
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
	/** Ctrl-C: stops the agent; the checks, the report and the release still run, later tools are `not_run` */
	signal?: AbortSignal;
	/** how kits find installed tools (default: `exec.which` + the real filesystem) */
	kitDeps?: KitDeps;
	/** the wait between SIGTERM and SIGKILL when stopping a tool's helpers (default 3 s) */
	sleep?: (ms: number) => Promise<void>;
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

export type AgentTools = { allowedTools: readonly string[]; mcpConfigPath?: string; settingsPath?: string };

/** `claude -p` argv: stream-json, the suite's model, the kit's tools (and MCP server), nothing from the user's setup. */
export function claudeArgs(prompt: string, suite: LoadedSuite["suite"], model: string, tools: AgentTools): string[] {
	return [
		"-p",
		prompt,
		"--output-format",
		"stream-json",
		"--verbose",
		"--model",
		model,
		"--allowedTools",
		...tools.allowedTools,
		"--permission-mode",
		"dontAsk",
		...(tools.mcpConfigPath !== undefined ? ["--mcp-config", tools.mcpConfigPath] : []),
		...(tools.settingsPath !== undefined ? ["--settings", tools.settingsPath] : []),
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

/** The tools to run: the suite's, narrowed by `--tools`, in the suite's order. */
export function selectTools(suiteTools: readonly ToolId[], only: readonly ToolId[] | undefined): ToolId[] {
	return only === undefined ? [...suiteTools] : suiteTools.filter((t) => only.includes(t));
}

/** State shared by every tool of one run. */
type RunCtx = {
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

/** The e2e-bench adapter's context, so its doctor / prepare / teardown see the same env as the agent. */
function adapterContext(ctx: RunCtx, kit: Kit, toolDir: string): RunContext {
	const { suite } = ctx.input.loaded;
	return {
		platform: suite.platform,
		udid: ctx.udid,
		bundleId: BUNDLE_ID,
		appPath: ctx.app.appPath,
		outDir: join(toolDir, "adapter"),
		cold: false,
		retries: 0,
		env: { ...ctx.deps.env, WARDEN_SESSION_ID: ctx.session, ...kit.env },
		exec: ctx.exec,
		log: (line) => ctx.deps.log(`${kit.tool}: ${line}`),
		packageRoot: join(ctx.input.repoRoot, "packages", "e2e-bench"),
		repoRoot: ctx.input.repoRoot,
	};
}

/** Every tool starts from the same place: no app data, the pinned build freshly installed. */
async function freshInstall(ctx: RunCtx): AsyncResult<void> {
	const { platform } = ctx.input.loaded.suite;
	await terminateApp(ctx.exec, platform, ctx.udid, BUNDLE_ID);
	const [cmd, args] =
		platform === "ios"
			? (["xcrun", ["simctl", "uninstall", ctx.udid, BUNDLE_ID]] as const)
			: (["adb", ["-s", ctx.udid, "uninstall", BUNDLE_ID]] as const);
	await ctx.exec.run(cmd, args, { timeoutMs: 60_000 });
	return installApp(ctx.exec, platform, ctx.udid, ctx.app.appPath);
}

/**
 * The tool's warm-up, outside the agent's wall time. warden: one `warden ui snapshot` through this checkout's CLI
 * (the helper the agent then reuses); argent / agent-device: the e2e-bench adapter's prepare (tool-server, runner).
 */
async function prepareTool(ctx: RunCtx, kit: Kit, actx: RunContext): AsyncResult<void> {
	if (kit.tool !== "warden") return kit.adapter.prepare(actx);
	if (ctx.input.loaded.suite.platform !== "ios") return ok(undefined);
	const ran = await runOk(ctx.exec, ctx.deps.bunPath, [ctx.cliPath, "ui", "snapshot", "--udid", ctx.udid, "--json"], {
		env: { WARDEN_SESSION_ID: ctx.session },
		timeoutMs: 120_000,
	});
	return ran.success ? ok(undefined) : err(ran.error);
}

/**
 * Stops what the tool left on the device before warden's checks (two accessibility clients on one simulator
 * collide): the adapter's teardown, then any of its helpers still alive that this run owns.
 */
async function stopToolHelpers(ctx: RunCtx, kit: Kit, actx: RunContext): Promise<void> {
	if (kit.tool === "warden") return;
	await kit.adapter.teardown(actx);
	const owned = [ctx.runDir, ...Object.values(kit.env)];
	const killed = await killMatching(
		ctx.exec,
		kit.adapter.residuePatterns.processes,
		{ udid: ctx.udid, benchPids: () => [], ownedPaths: owned },
		ctx.deps.sleep !== undefined ? { sleep: ctx.deps.sleep } : {}
	);
	for (const line of killed) ctx.deps.log(`${kit.tool}: stopped ${line}`);
}

type Driven = { agent: AgentRun; metrics: StreamMetrics; checks: Awaited<ReturnType<typeof runChecks>> };

/** Runs the agent in the kit's sandbox, stops the tool's helpers, runs the checks, closes warden's helper. */
async function drive(ctx: RunCtx, kit: Kit, actx: RunContext, toolDir: string): Promise<Driven> {
	const { suite, promptTemplate } = ctx.input.loaded;
	const sandbox = createSandbox(join(toolDir, "sandbox"), kit);
	const prompt = composePrompt(kit.preamble, promptTemplate, {
		udid: ctx.udid,
		platform: suite.platform,
		bundleId: BUNDLE_ID,
	});
	writeFileSync(join(toolDir, "prompt.md"), prompt);
	const parser = createStreamParser({
		driver: kit.driver,
		failurePatterns: [...kit.failurePatterns, ...suite.failurePatterns],
	});
	const transcript = join(toolDir, TRANSCRIPT_FILE);
	writeFileSync(transcript, "");
	const agent = await runAgent(ctx.deps, {
		args: claudeArgs(prompt, suite, ctx.model, {
			allowedTools: kit.allowedTools,
			...(sandbox.mcpConfigPath !== undefined ? { mcpConfigPath: sandbox.mcpConfigPath } : {}),
			...(sandbox.settingsPath !== undefined ? { settingsPath: sandbox.settingsPath } : {}),
		}),
		cwd: sandbox.workDir,
		env: sandbox.env(ctx.deps.env, ctx.session),
		maxTurns: suite.maxTurns,
		timeoutMs: suite.timeoutMs,
		onStdout: (line) => {
			appendFileSync(transcript, `${line}\n`);
			parser.push(line);
		},
		onTurn: (listener) => parser.onTurn(listener),
		stderrPath: join(toolDir, STDERR_FILE),
	});
	ctx.deps.log(`${kit.tool}: agent finished: exit ${agent.exitCode}${agent.stopped ? ` (${agent.stopped})` : ""}`);
	await stopToolHelpers(ctx, kit, actx);
	const env = { WARDEN_SESSION_ID: ctx.session };
	const checks = await runChecks(ctx.deps.exec, {
		checks: suite.success,
		udid: ctx.udid,
		bunPath: ctx.deps.bunPath,
		cliPath: ctx.cliPath,
		env,
	});
	// warden's helper for this device (the checks' or the agent's); the lease is released by the caller
	await ctx.deps.exec.run(ctx.deps.bunPath, [ctx.cliPath, "ui", "close", "--udid", ctx.udid], {
		env,
		timeoutMs: 30_000,
	});
	return { agent, metrics: parser.metrics(), checks };
}

type ToolInput = { kit: Kit; prepareMs: number; driven: Driven };

export function buildToolReport(suite: LoadedSuite["suite"], r: ToolInput): RanReport {
	const { agent, metrics, checks } = r.driven;
	const outcome = outcomeOf(agent, metrics, checks.passed);
	const diff = diffBaseline(suite.baseline?.[r.kit.tool], metrics, agent.wallMs);
	return {
		tool: r.kit.tool,
		ran: true,
		version: r.kit.version,
		outcome,
		prepareMs: Math.round(r.prepareMs),
		wallMs: agent.wallMs,
		exitCode: agent.exitCode,
		metrics,
		checks: checks.results,
		...(diff !== undefined ? { diff } : {}),
		...(outcome === "agent_error" && agent.stderrTail !== "" ? { stderrTail: agent.stderrTail } : {}),
		notes: r.kit.notes,
	};
}

const skipped = (tool: ToolId, outcome: "unavailable" | "setup_failed" | "not_run", reason: string): ToolReport => ({
	tool,
	ran: false,
	outcome,
	reason,
});

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One tool, start to finish; `previous` is the kit that ran before it on this device (for isolation). */
async function runTool(ctx: RunCtx, kit: Kit, previous: Kit | undefined): Promise<ToolReport> {
	const toolDir = join(ctx.runDir, kit.tool);
	mkdirSync(toolDir, { recursive: true });
	const actx = adapterContext(ctx, kit, toolDir);
	if (kit.tool !== "warden") {
		const doctor = await kit.adapter.doctor(actx);
		if (!doctor.ok) return { ...skipped(kit.tool, "unavailable", `${doctor.reason} (${doctor.installHint})`) };
	}
	const isolated = await isolate({
		exec: ctx.exec,
		platform: ctx.input.loaded.suite.platform,
		udid: ctx.udid,
		bundleId: BUNDLE_ID,
		...(previous !== undefined ? { previous: previous.adapter } : {}),
		next: kit.adapter,
		cold: false,
		rebootBetween: false,
		log: (line) => ctx.deps.log(`${kit.tool}: isolate: ${line}`),
		repoRoot: ctx.input.repoRoot,
		cliPath: ctx.cliPath,
		benchPids: () => [],
		ownedPaths: [ctx.runDir, ...Object.values(kit.env), ...Object.values(previous?.env ?? {})],
		...(ctx.deps.sleep !== undefined ? { sleep: ctx.deps.sleep } : {}),
	});
	if (!isolated.success) return skipped(kit.tool, "setup_failed", `isolate: ${errText(isolated.error)}`);
	const installed = await freshInstall(ctx);
	if (!installed.success) return skipped(kit.tool, "setup_failed", `install: ${errText(installed.error)}`);
	const t0 = performance.now();
	const prepared = await prepareTool(ctx, kit, actx);
	const prepareMs = performance.now() - t0;
	if (!prepared.success) {
		await stopToolHelpers(ctx, kit, actx);
		return skipped(kit.tool, "setup_failed", `prepare: ${errText(prepared.error)}`);
	}
	ctx.deps.log(`${kit.tool}: prepared in ${(prepareMs / 1000).toFixed(1)} s`);
	const driven = await drive(ctx, kit, actx, toolDir);
	return buildToolReport(ctx.input.loaded.suite, { kit, prepareMs, driven });
}

/** Resolves every selected tool's kit; the ones that cannot run here become `unavailable` rows. */
function resolveKits(
	tools: readonly ToolId[],
	input: RunInput,
	deps: RunDeps,
	cliPath: string
): { kits: Kit[]; unavailable: ToolReport[] } {
	const kitDeps = deps.kitDeps ?? defaultKitDeps((cmd) => deps.exec.which(cmd), deps.env);
	const kits: Kit[] = [];
	const unavailable: ToolReport[] = [];
	for (const tool of tools) {
		const kit = resolveKit(tool, { repoRoot: input.repoRoot, bunPath: deps.bunPath, cliPath }, kitDeps);
		if (kit.success) kits.push(kit.data);
		else unavailable.push(skipped(tool, "unavailable", String(kit.error)));
	}
	return { kits, unavailable };
}

type Setup = {
	app: BenchApp;
	tools: ToolId[];
	kits: Kit[];
	unavailable: ToolReport[];
	runId: string;
	startedAt: Date;
	session: string;
	runDir: string;
	cliPath: string;
};

/** Everything before the device: tools, preflight, kits, run id, session, run dir. */
function setup(input: RunInput, deps: RunDeps): Result<Setup> {
	const { suite } = input.loaded;
	const tools = selectTools(suite.tools, input.tools);
	if (tools.length === 0) return err(`--tools selects none of the suite's tools (${suite.tools.join(", ")})`);
	const app = preflight(input, deps);
	if (!app.success) return app;
	const cliPath = join(input.repoRoot, "apps", "cli", "src", "cli.ts");
	const { kits, unavailable } = resolveKits(tools, input, deps, cliPath);
	if (kits.length === 0)
		return err(`no tool can run here: ${unavailable.map((u) => (u.ran ? u.tool : u.reason)).join("; ")}`);
	const startedAt = deps.now();
	const runId = runIdFor(suite.name, startedAt);
	const session = sessionFor(input, deps.env, runId);
	if (!session.success) return session;
	const runDir = input.outDir ?? join(input.repoRoot, ".bench", runId);
	return ok({ app: app.data, tools, kits, unavailable, runId, startedAt, session: session.data, runDir, cliPath });
}

/** Every available tool in turn on the claimed device; an interrupted run marks the rest `not_run`. */
async function runTools(ctx: RunCtx, s: Setup): Promise<ToolReport[]> {
	const results: ToolReport[] = [...s.unavailable];
	let previous: Kit | undefined;
	for (const kit of s.kits) {
		if (ctx.deps.signal?.aborted) {
			results.push(skipped(kit.tool, "not_run", "the run was interrupted before this tool"));
			continue;
		}
		ctx.deps.log(`${kit.tool} ${kit.version}: starting`);
		results.push(await runTool(ctx, kit, previous));
		previous = kit;
	}
	return results.sort((a, b) => s.tools.indexOf(a.tool) - s.tools.indexOf(b.tool));
}

/**
 * Claims (or reuses) one device, then runs every selected tool on it in turn: isolate, fresh install, prepare,
 * the agent in the tool's sandbox, stop its helpers, success checks. Writes `report.json` / `report.md` (the
 * comparison table last) and per-tool transcripts, and releases exactly the lease it claimed.
 */
export async function runAgentBench(input: RunInput, deps: RunDeps): AsyncResult<RunOutput> {
	const { suite } = input.loaded;
	const prepared = setup(input, deps);
	if (!prepared.success) return prepared;
	const s = prepared.data;
	mkdirSync(s.runDir, { recursive: true });
	const exec = withEnv(deps.exec, { WARDEN_SESSION_ID: s.session });
	const { cliPath } = s;
	const { repoRoot } = input;

	const claimed = await claimDevice(exec, {
		platform: suite.platform,
		cliPath,
		repoRoot,
		...(input.udid !== undefined ? { udid: input.udid } : {}),
		log: deps.log,
	});
	if (!claimed.success) return claimed;
	const device: ClaimedDevice = claimed.data;
	const leaseId = device.leaseId;
	deps.log(`device ${device.udid}${leaseId ? ` (lease ${leaseId})` : ""}`);
	const heartbeat =
		leaseId === undefined
			? undefined
			: setInterval(() => {
					void heartbeatDevice(exec, { cliPath, leaseId, repoRoot });
				}, deps.heartbeatMs ?? HEARTBEAT_MS);

	const model = input.model ?? suite.model;
	const ctx: RunCtx = {
		input,
		deps,
		exec,
		app: s.app,
		runDir: s.runDir,
		cliPath,
		session: s.session,
		udid: device.udid,
		model,
	};
	try {
		const report: AgentReport = {
			reportVersion: 2,
			runId: s.runId,
			suite: suite.name,
			model,
			platform: suite.platform,
			udid: device.udid,
			startedAt: s.startedAt.toISOString(),
			tools: await runTools(ctx, s),
		};
		writeFileAtomic(join(s.runDir, REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`);
		writeFileAtomic(join(s.runDir, REPORT_MD), renderMarkdown(report));
		return ok({ report, runDir: s.runDir });
	} finally {
		if (heartbeat !== undefined) clearInterval(heartbeat);
		if (leaseId !== undefined) {
			const released = await releaseDevice(exec, { cliPath, leaseId, repoRoot });
			deps.log(released.success ? `released ${leaseId}` : `release failed: ${String(released.error)}`);
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
