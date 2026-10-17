import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Command as Commander, OptionValues } from "@commander-js/extra-typings";
import { expandArgv, expandText, jobSlug, parseJobLines, parseJobList } from "@delacour/warden-core/batch/expand";
import { type BatchJobsSource, type BatchPreset, findBatchPreset } from "@delacour/warden-core/batch/preset";
import { type BatchEvent, type BatchSummary, type BatchWorker, runBatch } from "@delacour/warden-core/batch/schedule";
import type { ClaimOutcome } from "@delacour/warden-core/claim";
import { formatDuration, parseDuration } from "@delacour/warden-core/duration";
import { bunExec, execError } from "@delacour/warden-core/exec";
import { readGitFacts } from "@delacour/warden-core/git-facts";
import { resolveHeadless } from "@delacour/warden-core/headless";
import { isPortFree } from "@delacour/warden-core/ports";
import { slimSimulator } from "@delacour/warden-core/sims/slim";
import { wardenHome } from "@delacour/warden-core/store";
import type { Platform } from "@delacour/warden-core/types";
import { ENV_NAMES } from "@delacour/warden-e2e/env";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { maybeAutoGc } from "../autogc";
import { type Cast, createCast } from "../batch/cast";
import { type EarlyWarm, startEarlyWarm } from "../batch/early-warm";
import { flowPoller } from "../batch/flow-poller";
import type { FlowMark, TrackedFlow } from "../batch/flow-progress";
import { type Recording, startSimRecording, videoName } from "../batch/record";
import { type ReadFrom, readFileFrom } from "../batch/results-tail";
import { type RunnerReport, resultsReport } from "../batch/runner-report";
import { captureScreenshot } from "../batch/screenshot";
import { parseReadySpec, probeReady, type ReadySpec } from "../batch/serve";
import { type DeviceSetup, type DeviceSetupSpec, setupDevices } from "../batch/setup";
import { openStampedLog } from "../batch/stamped-log";
import {
	addRunnerFlows,
	applyEvent,
	applyFlowMarks,
	applyRunnerReport,
	type BatchView,
	initialView,
	type LiveScreen,
	liveScreen,
	plainLine,
	render,
	withRunners,
} from "../batch/tui";
import type { WarmConnect, WarmHelper } from "../batch/warm-drivers";
import {
	bootedByClaim,
	type ClaimFlags,
	type ClaimFlagValues,
	parseClaimFlags,
	resolveOwner,
	resolvePlatform,
	withClaimOptions,
} from "../claim-flags";
import { type Command, defineCommand } from "../command";
import type { CommandContext } from "../context";
import { shutdownReleasedDevices } from "../device-shutdown";
import { helperDir } from "../e2e/bun-runner";
import { residentSocket, warmConnect } from "../e2e/warm-connect";
import {
	type AppFlagValues,
	claimAll,
	exitCodeOf,
	type ForwardedSignal,
	holdLeases,
	INTERRUPTED,
	intervalEvery,
	type LeaseArgs,
	type LeaseSession,
	type LeaseSessionDeps,
	leasedProgress,
	leasedText,
	parseAppFlags,
	processOnSignal,
	type RunPort,
	splitCommand,
	withLeaseOptions,
} from "../lease-session";
import {
	adbReverseArgv,
	devClientLaunchArgv,
	type Metro,
	type MetroOwner,
	metroOwner,
	prewarmMetro,
	resolveExpoBin,
	startMetro,
} from "../metro";
import { emit, note, reportError, warn } from "../output";
import { hideSimWindows } from "../sim-windows";
import { withSpinner } from "../spinner-context";

export type KillSignal = ForwardedSignal | "SIGKILL";

export type ProcHandle = { exited: Promise<number>; kill: (signal: KillSignal) => void };

export type SpawnOptions = {
	env: Record<string, string | undefined>;
	/** stdout + stderr are appended to this file, each line stamped `[HH:MM:SS.mmm] ` (and the child gets `WARDEN_LOG_TIMESTAMPS=1`) */
	log: string;
	/** own process group (detached); `kill` signals the whole group */
	group?: boolean;
	/** the invoking directory (`ctx.cwd`), or the preset's cwd */
	cwd: string;
	/** a per-device `setup` command rather than a job */
	setup?: true;
	/** the run's own Metro (a `group` spawn, like serve) */
	metro?: true;
	/** a job (jobs with a timeout are `group` spawns too, so the whole tree can be killed) */
	job?: true;
	/** a driver warm-up (`hooks.warmDrivers`) */
	warm?: true;
};

/** Where the TUI goes (stderr by default). */
export type Terminal = { isTTY: boolean; columns: number; write: (data: string) => void };

/** Side effects of `warden batch`, injectable for tests. */
export type BatchDeps = LeaseSessionDeps & {
	spawn: (cmd: string[], opts: SpawnOptions) => ProcHandle;
	/** one `--serve-ready` check */
	probe: (spec: ReadySpec) => Promise<boolean>;
	sleep: (ms: number) => Promise<void>;
	/** `--record`: start recording `udid` into `path` */
	record: (udid: string, path: string) => Promise<Recording>;
	/**
	 * Best-effort screenshot of a device after a job failed, into `path`. Resolves false when it
	 * could not (and must stay within a few seconds): a failure shot never fails or stalls the batch.
	 */
	screenshot: (platform: Platform, udid: string, path: string) => Promise<boolean>;
	/** `slim: true`: switch off the unneeded daemons on one iOS simulator (resolves to the jobs touched) */
	slim: (udid: string) => AsyncResult<string[]>;
	/** write a file, creating its parent dirs */
	writeFile: (path: string, data: string) => Promise<void>;
	readFile: (path: string) => Promise<string>;
	/** a file from a byte offset on: how the flow poller reads only what a `results.jsonl` gained */
	readFrom: ReadFrom;
	mkdir: (dir: string) => Promise<void>;
	newId: () => string;
	terminal: Terminal;
	/** run `fn` once after `ms` (job timeouts); returns cancel */
	after: (ms: number, fn: () => void) => () => void;
	/** who serves the run's Metro port, relative to the project root */
	metroProbe: (port: number, projectRoot: string) => Promise<MetroOwner>;
	/** build the bundle once before the first job */
	prewarm: (url: string, platform: Platform) => AsyncResult<{ bundled: boolean }>;
	/** how `hooks.warmDrivers` reaches one device's socket helper (default: `e2e/warm-connect`) */
	warmConnect: (ctx: CommandContext) => WarmConnect;
	/** a device's running resident helper socket, for `hooks.residentSocket` when there is no warm-up (default: `e2e/warm-connect`) */
	residentSocket?: (ctx: CommandContext) => (udid: string) => Promise<string | undefined>;
	/** `Bun.which`: where a command is on PATH */
	which: (cmd: string) => string | null | undefined;
	/** `Bun.resolveSync`: the file a package specifier resolves to from `from` (throws when it does not) */
	resolveModule: (specifier: string, from: string) => string;
	/** where the spec drivers' native helper lives next to this warden (`WARDEN_HELPER_DIR`) */
	helperDir: () => string;
};

/** Commander option values of `warden batch`. */
export type BatchOpts = ClaimFlagValues &
	AppFlagValues & {
		json?: true;
		port: string[];
		jobs?: string;
		jobsFrom?: string;
		retry: string;
		passes: string;
		serve?: string;
		serveReady?: string;
		serveTimeout: string;
		jobTimeout?: string;
		record?: string;
		logs?: string;
		/** false = `--no-tui` */
		tui: boolean;
	};

/** `cmd` and `ready` may hold `{port}` / `{metroUrl}`, known only once the run has its leases. */
type Serve = { cmd: string; ready?: { spec: string; cwd: string }; timeoutMs: number };

/** A device leg of the run: its own claim, env and job queue (`e2e.<suite>.devices[]`). */
export type BatchLeg = { name: string; flags: ClaimFlags; env: Record<string, string> };

/** The run's own Metro (`e2e.<suite>.metro`); it listens on the first leased port. */
export type MetroPlan = {
	projectRoot: string;
	env: Record<string, string>;
	prewarm: boolean;
	readyTimeoutMs: number;
	launchArgs: string[];
	/** the app warden opens on each device, pointed at Metro (undefined: the runner opens it itself) */
	bundleId?: string;
};

/** A validated `warden batch` run (what `runSession` takes); `warden e2e` adds legs and `metro`. */
export type BatchArgs = LeaseArgs & {
	json: boolean;
	jobs: BatchJobsSource;
	retry: number;
	/** consecutive green runs a job needs (each a fresh spawn on the same device) */
	passes: number;
	/** where serve, the jobs and a `jobsFrom.command` run */
	cwd: string;
	/** preset `env`, added to the serve + job env */
	env: Record<string, string>;
	serve?: Serve;
	record?: string;
	logs?: string;
	tui: boolean;
	/** a job process still going after this is killed and counts as failed (exit 124) */
	jobTimeoutMs?: number;
	/** device legs, claimed instead of `flags`; each runs every job on its own devices */
	legs?: BatchLeg[];
	metro?: MetroPlan;
};

/** The id a job runs under in the scheduler: qualified with its leg when the run has several. */
export const legJob = (job: string, leg: string | undefined): string => (leg === undefined ? job : `${job}@${leg}`);

/** Exit code of a job killed for running past `jobTimeoutMs` (as `timeout(1)`). */
export const TIMEOUT_EXIT = 124;

const SERVE_KILL_GRACE_MS = 15_000;
/** SIGTERM → SIGKILL for a timed-out job. */
const JOB_KILL_GRACE_MS = 5_000;
const READY_POLL_MS = 500;
/** the grid is redrawn this often, and at once on every event: what changes between events is the clocks, which show whole seconds */
const FRAME_MS = 1_000;

const absolute = (cwd: string, path: string) => (isAbsolute(path) ? path : resolve(cwd, path));

/** `--jobs` / `--jobs-from` (exactly one, else the preset's source) → where the jobs come from. */
function parseJobsSource(opts: BatchOpts, cwd: string, fallback?: BatchJobsSource): Result<BatchJobsSource> {
	if (opts.jobs === undefined && opts.jobsFrom === undefined && fallback) return ok(fallback);
	if ((opts.jobs === undefined) === (opts.jobsFrom === undefined))
		return err("pass exactly one of --jobs / --jobs-from");
	if (opts.jobsFrom !== undefined)
		return ok(opts.jobsFrom === "-" ? { kind: "stdin" } : { kind: "file", path: absolute(cwd, opts.jobsFrom) });
	const jobs = parseJobList(opts.jobs ?? "");
	return jobs.length > 0 ? ok({ kind: "list", jobs }) : err("--jobs is empty");
}

/** `--serve` / `--serve-ready` / `--serve-timeout` → serve config (undefined without `--serve`). */
function parseServe(opts: BatchOpts, cwd: string): Result<Serve | undefined> {
	if (opts.serve === undefined)
		return opts.serveReady === undefined ? ok(undefined) : err("--serve-ready needs --serve");
	const timeoutMs = parseDuration(opts.serveTimeout);
	if (!timeoutMs.success) return err(`--serve-timeout: ${timeoutMs.error}`);
	if (opts.serveReady === undefined) return ok({ cmd: opts.serve, timeoutMs: timeoutMs.data });
	// validated now with stand-in values; parsed for real once the port is leased
	const ready = parseReadySpec(expandText(opts.serveReady, { port: 1, metroUrl: "http://127.0.0.1:1" }), cwd);
	if (!ready.success) return ready;
	return ok({ cmd: opts.serve, timeoutMs: timeoutMs.data, ready: { spec: opts.serveReady, cwd } });
}

/** `--retry` / `--passes` / `--job-timeout` → validated numbers. */
function parseLimits(opts: BatchOpts): Result<Pick<BatchArgs, "retry" | "passes" | "jobTimeoutMs">> {
	if (!/^\d+$/.test(opts.retry)) return err(`--retry must be an integer >= 0, got "${opts.retry}"`);
	if (!/^\d+$/.test(opts.passes) || Number(opts.passes) < 1)
		return err(`--passes must be an integer >= 1, got "${opts.passes}"`);
	const jobTimeout = opts.jobTimeout === undefined ? ok(undefined) : parseDuration(opts.jobTimeout);
	if (!jobTimeout.success) return err(`--job-timeout: ${jobTimeout.error}`);
	return ok({
		retry: Number(opts.retry),
		passes: Number(opts.passes),
		...(jobTimeout.data !== undefined ? { jobTimeoutMs: jobTimeout.data } : {}),
	});
}

/** What a preset adds beyond option values: its jobs source, env and cwd. */
export type BatchBase = { jobs?: BatchJobsSource; env?: Record<string, string>; cwd?: string };

/**
 * Validated batch args from the resolved platform + option values (nothing is claimed yet).
 * Relative option paths resolve against `cwd` (the invoking dir); serve / jobs run in `base.cwd ?? cwd`.
 */
export function parseBatchArgs(
	platform: Platform,
	opts: BatchOpts,
	cwd: string,
	base: BatchBase = {}
): Result<BatchArgs> {
	const flags = parseClaimFlags(platform, opts);
	if (!flags.success) return flags;
	const app = parseAppFlags(opts);
	if (!app.success) return app;
	const jobs = parseJobsSource(opts, cwd, base.jobs);
	if (!jobs.success) return jobs;
	const limits = parseLimits(opts);
	if (!limits.success) return limits;
	const serve = parseServe(opts, cwd);
	if (!serve.success) return serve;
	if (opts.record !== undefined && platform !== "ios") return err("--record is iOS-only");
	return ok({
		flags: flags.data,
		ports: opts.port,
		json: opts.json === true,
		jobs: jobs.data,
		...limits.data,
		tui: opts.tui,
		cwd: base.cwd ?? cwd,
		env: base.env ?? {},
		...(app.data ? { app: app.data } : {}),
		...(serve.data ? { serve: serve.data } : {}),
		...(opts.record !== undefined ? { record: absolute(cwd, opts.record) } : {}),
		...(opts.logs !== undefined ? { logs: absolute(cwd, opts.logs) } : {}),
	});
}

/** `jobsFrom: { command }`: `sh -c` in the batch cwd; stdout lines are the jobs. */
async function commandJobs(ctx: CommandContext, args: BatchArgs, command: string): AsyncResult<string[]> {
	const cmd = ["sh", "-c", command];
	const res = await ctx.exec(cmd, { cwd: args.cwd, env: { ...ctx.env, ...args.env } });
	if (res.exitCode !== 0) return err(`jobsFrom.command: ${execError(cmd, res)}`);
	const jobs = parseJobLines(res.stdout);
	return jobs.length > 0 ? ok(jobs) : err(`jobsFrom.command: no jobs from \`${command}\``);
}

async function loadJobs(ctx: CommandContext, deps: BatchDeps, args: BatchArgs): AsyncResult<string[]> {
	const source = args.jobs;
	if (source.kind === "list") return ok(source.jobs);
	if (source.kind === "command") return commandJobs(ctx, args, source.command);
	try {
		const jobs = parseJobLines(source.kind === "stdin" ? await ctx.readStdin() : await deps.readFile(source.path));
		return jobs.length > 0 ? ok(jobs) : err("--jobs-from: no jobs");
	} catch (error) {
		return err(`--jobs-from: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** SIGTERM the serve group, SIGKILL after the grace period. */
async function stopServe(deps: BatchDeps, serve: ProcHandle): Promise<void> {
	const exited = serve.exited.then(() => true);
	const waitExit = () => Promise.race([exited, deps.sleep(SERVE_KILL_GRACE_MS).then(() => false)]);
	serve.kill("SIGTERM");
	if (await waitExit()) return;
	serve.kill("SIGKILL");
	await waitExit();
}

/** Poll `ready` until it passes; fails when serve exits first, on timeout, or when `aborted`. */
async function waitReady(
	ctx: CommandContext,
	deps: BatchDeps,
	serve: Serve,
	ready: ReadySpec | undefined,
	proc: ProcHandle,
	aborted: () => boolean
): AsyncResult<void> {
	let exitCode: number | undefined;
	void proc.exited.then((code) => {
		exitCode = code;
	});
	if (!ready) return ok(undefined);
	const deadline = ctx.now() + serve.timeoutMs;
	for (;;) {
		if (aborted()) return err("interrupted while waiting for serve");
		if (await deps.probe(ready)) return ok(undefined);
		await Promise.resolve();
		if (exitCode !== undefined) return err(`serve exited (${exitCode}) before ready`);
		if (ctx.now() >= deadline) return err(`serve not ready after ${Math.round(serve.timeoutMs / 1000)}s`);
		await deps.sleep(READY_POLL_MS);
	}
}

type Device = BatchWorker & { name: string; video?: string; videoStartedAt?: number; leg?: string };

/** The devices of one leg (a plain batch has one unnamed pool). */
type Pool = { leg?: string; env: Record<string, string>; devices: Device[] };

/** Values known once the run has its leases, substituted into serve and every job argv. */
type RunVars = { port?: number; metroUrl?: string };

/** Failure screenshots by attempt: `<worker>:<seq>` → absolute png path. */
export type Screenshots = ReadonlyMap<string, string>;

/** Job logs by attempt: `<worker>:<seq>` → absolute log path. */
export type Logs = ReadonlyMap<string, string>;

/** Spec results by attempt: `<worker>:<seq>` → the `results.jsonl` the job writes (jobs whose env sets `WARDEN_E2E_OUT`). */
export type ResultFiles = ReadonlyMap<string, string>;

/** Key of one job attempt in `Screenshots` / `Logs`. */
export const attemptKey = (r: { worker: number; seq: number }) => `${r.worker}:${r.seq}`;

/** The `batch.json` document (record-dir contract; also the `--json` output). */
function summaryJson(
	batchId: string,
	cmd: string[],
	startedAt: number,
	endedAt: number,
	devices: Device[],
	summary: BatchSummary,
	screenshots: Screenshots,
	headless: boolean
) {
	return {
		batchId,
		cmd,
		startedAt,
		endedAt,
		ok: summary.ok,
		headless,
		devices: devices.map((d) => ({
			worker: d.worker,
			udid: d.udid,
			name: d.name,
			...(d.leg !== undefined ? { leg: d.leg } : {}),
			...(d.video !== undefined ? { video: d.video, videoStartedAt: d.videoStartedAt } : {}),
		})),
		jobs: summary.results.map((r) => ({
			...(screenshots.has(attemptKey(r)) ? { screenshot: screenshots.get(attemptKey(r)) } : {}),
			job: r.job,
			worker: r.worker,
			udid: r.udid,
			seq: r.seq,
			attempt: r.attempt,
			startedAt: r.startedAt,
			endedAt: r.endedAt,
			exitCode: r.exitCode,
		})),
	};
}

/** TUI sinks: the terminal (live grid or plain lines) and the `tui.cast` mirror. */
type Display = {
	event: (e: BatchEvent) => void;
	/** flow results read off `worker`'s spec output */
	flows: (worker: number, marks: Readonly<Record<string, FlowMark>>) => void;
	/** finished tests, one line each (`--no-tui` only: the grid shows flows) */
	tests: (lines: readonly string[]) => void;
	/** the spec runner's report: the flows each device ran */
	report: (report: RunnerReport) => void;
	end: () => void;
	cast?: Cast;
};

function display(
	ctx: CommandContext,
	deps: BatchDeps,
	args: BatchArgs,
	view: { current: BatchView },
	flows: readonly TrackedFlow[] | undefined
): Display {
	const { terminal } = deps;
	const live = args.tui && terminal.isTTY;
	const width = live ? terminal.columns : 100;
	// the grid (header, device rows, flow lines) + the cursor row its trailing newline leaves
	const height = render(view.current, { width, color: false }).split("\n").length + 1;
	const cast = args.record ? createCast({ width, height, startedAt: ctx.now() }) : undefined;
	const sinks: Array<{ screen: LiveScreen; color: boolean; last?: string }> = [];
	if (live) sinks.push({ screen: liveScreen(terminal.write), color: ctx.ui.color.level > 0 });
	if (cast) sinks.push({ screen: liveScreen((data) => cast.write(ctx.now(), data)), color: true });
	const frame = (final: boolean) => {
		view.current = { ...view.current, now: ctx.now() };
		for (const sink of sinks) {
			const text = render(view.current, { width, color: sink.color });
			if (final) sink.screen.end(text);
			else if (text !== sink.last) sink.screen.draw(text);
			sink.last = text;
		}
	};
	frame(false);
	const stopFrames = sinks.length > 0 ? deps.every(FRAME_MS, () => frame(false)) : () => {};
	return {
		cast,
		event: (e) => {
			view.current = applyEvent(view.current, e);
			if (e.type === "job-start") {
				const ids = shardFlowIds(flows, e.job);
				if (ids.length > 0) view.current = addRunnerFlows(view.current, e.worker, ids);
			}
			if (!live) {
				const text = plainLine(view.current, e);
				if (text !== undefined) ctx.err(text);
			}
			frame(false);
		},
		flows: (worker, marks) => {
			if (!live) announceFlows(ctx, view.current, worker, marks);
			view.current = applyFlowMarks(view.current, worker, marks);
			frame(false);
		},
		tests: (lines) => {
			if (!live) for (const line of lines) ctx.err(line);
		},
		report: (report) => {
			view.current = applyRunnerReport(view.current, report);
			if (!live) announceDevices(ctx, view.current);
			frame(false);
		},
		end: () => {
			stopFrames();
			frame(true);
		},
	};
}

/** The flows of the shard job `job` (`shard-0`, or `shard-0@<leg>`), for the grid row that runs it. */
function shardFlowIds(flows: readonly TrackedFlow[] | undefined, job: string): string[] {
	return (flows ?? [])
		.filter((f) => f.job !== undefined && (job === f.job || job.startsWith(`${f.job}@`)))
		.map((f) => f.id);
}

/** Run every pool's queue behind the grid; a run with `flows` also ticks them off live from the jobs' `results.jsonl`. */
async function runGrid(
	ctx: CommandContext,
	deps: BatchDeps,
	args: BatchArgs,
	r: RunContext,
	queues: readonly Queue[],
	o: {
		total: number;
		startedAt: number;
		resultFiles: ResultFiles;
		flows: readonly TrackedFlow[] | undefined;
	}
): Promise<{ summary: BatchSummary; screen: Display }> {
	const rows = queues.flatMap((q) => q.rows);
	const { flows } = o;
	const screen = display(ctx, deps, args, { current: startView(rows, o.total, o.startedAt, flows) }, flows);
	const ended = new Set<string>();
	const poller = flows ? flowPoller(deps, flows, o.resultFiles, ended, screen) : undefined;
	try {
		const summary = await runPools(queues, {
			retry: args.retry,
			now: ctx.now,
			signal: r.signal,
			onEvent: (e) => {
				if (e.type === "job-end") ended.add(attemptKey(e));
				screen.event(e);
			},
		});
		poller?.stop();
		await poller?.poll();
		if (flows) await readRunnerReport(deps, o.resultFiles, flows, o.startedAt, screen);
		return { summary, screen };
	} finally {
		poller?.stop();
	}
}

/** Hand every job's finished `results.jsonl` to the display as one report (the last attempt of a flow wins); missing files and stale results are skipped. */
async function readRunnerReport(
	deps: BatchDeps,
	resultFiles: ResultFiles,
	flows: readonly TrackedFlow[],
	since: number,
	screen: Display
): Promise<void> {
	const texts = await Promise.all([...resultFiles.values()].map((path) => deps.readFile(path).catch(() => "")));
	const report = resultsReport(texts, flows, since);
	if (report) screen.report(report);
}

/** The grid's first frame: with sharded flows, one (empty) runner per worker that takes its shard's flows when the shard starts. */
function startView(
	rows: ReadonlyArray<{ worker: number; udid: string; name: string }>,
	total: number,
	startedAt: number,
	flows: readonly TrackedFlow[] | undefined
): BatchView {
	const view = initialView(rows, total, startedAt);
	return flows?.some((f) => f.job !== undefined) ? withRunners(view, []) : view;
}

const tick = (mark: FlowMark) => (mark === "passed" ? "✓" : "✗");

/** `--no-tui`: one line per flow the first time it is marked (or its mark changes), named by the worker's pool. */
function announceFlows(
	ctx: CommandContext,
	view: BatchView,
	worker: number,
	marks: Readonly<Record<string, FlowMark>>
): void {
	const [first, ...rest] = view.devices.filter((d) => d.worker === worker);
	const name = `${first?.name ?? "?"}${rest.length > 0 ? ` +${rest.length}` : ""}`;
	for (const f of view.runners?.find((r) => r.worker === worker)?.flows ?? []) {
		const mark = marks[f.id];
		if (mark && mark !== f.mark) ctx.err(`${name} ${tick(mark)} ${f.id}`);
	}
}

/** `--no-tui`: after the runner's report, one line per device with the flows it ran. */
function announceDevices(ctx: CommandContext, view: BatchView): void {
	for (const d of view.devices)
		if (d.ran && d.ran.length > 0) ctx.err(`${d.name}: ${d.ran.map((f) => `${tick(f.mark)} ${f.id}`).join("  ")}`);
}

/** Start one recording per device (in parallel); failures stop the ones that started. */
async function startRecordings(deps: BatchDeps, dir: string, devices: Device[]): AsyncResult<Recording[]> {
	const started = await Promise.allSettled(devices.map((d) => deps.record(d.udid, join(dir, videoName(d.worker)))));
	const recordings = started.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
	const failed = started.find((s) => s.status === "rejected");
	if (failed) {
		await Promise.all(recordings.map((r) => r.stop()));
		return err(`--record: ${failed.reason instanceof Error ? failed.reason.message : String(failed.reason)}`);
	}
	devices.forEach((d, i) => {
		d.video = videoName(d.worker);
		d.videoStartedAt = recordings[i]?.startedAt;
	});
	return ok(recordings);
}

/**
 * Per-job argv before `{job}` `{udid}` `{worker}` `{seq}` expansion (default: the batch command).
 * Asked once per spawn, so a retry (`run.attempt` > 0) can run less than the first attempt did.
 */
export type ArgvFor = (job: string, run: JobEnvInput) => string[] | Promise<string[]>;

type JobRunnerOptions = {
	cmd: string[];
	hooks: SessionHooks;
	/** the pool's env (lease + preset / suite + leg) */
	env: Record<string, string | undefined>;
	pool: Pool;
	/** the pool's devices that survived setup */
	live: readonly Device[];
	/** job ids carry `@<leg>` (several legs) */
	qualified: boolean;
	vars: RunVars;
	cwd: string;
	batchDir: string;
	logDir: string;
	passes: number;
	platform: Platform;
	jobTimeoutMs?: number | undefined;
	/** a job ran past `jobTimeoutMs` and is being killed */
	onTimeout: (job: string, w: BatchWorker) => void;
	/** filled with a failed attempt's screenshot (`attemptKey`) */
	screenshots: Map<string, string>;
	/** filled with each attempt's log (`attemptKey`); a later pass overwrites, so a failed attempt keeps the failing run's */
	logs: Map<string, string>;
	/** filled with each attempt's `results.jsonl` (`attemptKey`), for jobs whose env sets `WARDEN_E2E_OUT` */
	resultFiles: Map<string, string>;
	/** each warm device's helper socket (udid → path), filled by the warm step before the first job */
	sockets: ReadonlyMap<string, string>;
	running: Set<ProcHandle>;
	interrupted: () => boolean;
};

/** Arm the job timeout: `onExpire` (the screenshot) runs first, then SIGTERM, then SIGKILL after the grace period. */
function watchdog(deps: BatchDeps, timeoutMs: number | undefined, proc: ProcHandle, onExpire: () => Promise<void>) {
	let fired = false;
	let cancelKill = () => {};
	const cancel =
		timeoutMs === undefined
			? () => {}
			: deps.after(timeoutMs, () => {
					fired = true;
					void onExpire().finally(() => {
						proc.kill("SIGTERM");
						cancelKill = deps.after(JOB_KILL_GRACE_MS, () => proc.kill("SIGKILL"));
					});
				});
	return {
		expired: () => fired,
		cancel: () => {
			cancel();
			cancelKill();
		},
	};
}

/** `WARDEN_DEVICE_NAME`: lets a spec tell its own device from the others on a shared Metro. */
const deviceNameEnv = (name: string | undefined): Record<string, string> =>
	name === undefined ? {} : { [ENV_NAMES.deviceName]: name };

/** `WARDEN_SIMD_SOCKET` for a job on a device whose helper is warm. */
const socketEnv = (socketPath: string | undefined): Record<string, string> =>
	socketPath === undefined ? {} : { [ENV_NAMES.simdSocket]: socketPath };

/**
 * The per-job `run` for `runBatch`: expand the argv, spawn with the job env + log, track it for
 * SIGINT. With `passes` > 1 the job is spawned again after each green run (`WARDEN_PASS`, one log
 * per pass); the first red run is the attempt's exit code. A job past `jobTimeoutMs` is shot,
 * then killed, and its attempt exits `TIMEOUT_EXIT`.
 */
function jobRunner(deps: BatchDeps, o: JobRunnerOptions) {
	const { leg } = o.pool;
	const baseJob = (id: string) => (o.qualified && leg !== undefined ? id.slice(0, -(leg.length + 1)) : id);
	/** the device of a failed attempt, next to its log (`….log` → `….png`); never throws */
	const shoot = async (w: BatchWorker, seq: number, log: string): Promise<void> => {
		const key = attemptKey({ worker: w.worker, seq });
		const path = log.replace(/\.log$/, ".png");
		try {
			if ((await deps.screenshot(o.platform, w.udid, path)) && !o.screenshots.has(key)) o.screenshots.set(key, path);
		} catch {
			// best effort
		}
	};
	/** env, argv and log of one spawn: the pool env + the caller's per-job env (`hooks.jobEnv`) + this worker's identity */
	const plan = async (w: BatchWorker, id: string, seq: number, attempt: number, pass: number) => {
		const job = baseJob(id);
		const input: JobEnvInput = {
			job,
			worker: w.worker,
			seq,
			attempt,
			udid: w.udid,
			batchDir: o.batchDir,
			metroUrl: o.vars.metroUrl,
		};
		const env: Record<string, string | undefined> = {
			...o.env,
			...o.hooks.jobEnv?.(input),
			...socketEnv(o.sockets.get(w.udid)),
			WARDEN_UDID: w.udid,
			...deviceNameEnv(o.live.find((d) => d.udid === w.udid)?.name),
			WARDEN_WORKER: String(w.worker),
			WARDEN_JOB: job,
			WARDEN_JOB_SEQ: String(seq),
			WARDEN_PASS: String(pass),
		};
		const suffix = o.passes > 1 ? `.pass${pass}` : "";
		const log = join(o.logDir, `${w.worker}-${seq}-${jobSlug(id)}${suffix}.log`);
		const vars = {
			job,
			udid: w.udid,
			worker: w.worker,
			seq,
			...o.vars,
			...(leg !== undefined ? { leg } : {}),
		};
		const argv = expandArgv(o.hooks.argvFor ? await o.hooks.argvFor(job, input) : o.cmd, vars);
		return { job, env, log, argv };
	};
	const spawnOnce = async (w: BatchWorker, id: string, seq: number, attempt: number, pass: number): Promise<number> => {
		const { job, env, log, argv } = await plan(w, id, seq, attempt, pass);
		o.logs.set(attemptKey({ worker: w.worker, seq }), log);
		const out = env[ENV_NAMES.out];
		if (out) o.resultFiles.set(attemptKey({ worker: w.worker, seq }), join(out, "results.jsonl"));
		let proc: ProcHandle;
		try {
			const group = o.jobTimeoutMs !== undefined ? { group: true } : {};
			proc = deps.spawn(argv, { env, log, cwd: o.cwd, job: true, ...group });
		} catch {
			return 127;
		}
		o.running.add(proc);
		const timer = watchdog(deps, o.jobTimeoutMs, proc, async () => {
			o.onTimeout(job, w);
			await shoot(w, seq, log);
		});
		let code: number;
		try {
			code = await proc.exited;
		} finally {
			timer.cancel();
			o.running.delete(proc);
		}
		if (timer.expired()) return TIMEOUT_EXIT;
		if (code !== 0 && !o.interrupted()) await shoot(w, seq, log);
		return code;
	};
	return async (w: BatchWorker, job: string, seq: number, attempt = 0): Promise<number> => {
		for (let pass = 0; pass < o.passes; pass++) {
			const code = await spawnOnce(w, job, seq, attempt, pass);
			if (code !== 0) return code;
			if (o.interrupted()) return 130;
		}
		return 0;
	};
}

type BatchRun = {
	batchId: string;
	batchDir: string;
	logDir: string;
	cmd: string[];
	devices: Device[];
	/** number of jobs queued */
	total: number;
	startedAt: number;
	endedAt: number;
	summary: BatchSummary;
	screenshots: Screenshots;
	cast?: Cast;
};

/** Write `batch.json` (+ `tui.cast`), print `--json` / the closing lines. */
async function report(ctx: CommandContext, deps: BatchDeps, args: BatchArgs, r: BatchRun): Promise<void> {
	const headless = args.flags.headless === true;
	const doc = summaryJson(r.batchId, r.cmd, r.startedAt, r.endedAt, r.devices, r.summary, r.screenshots, headless);
	await deps.writeFile(join(r.batchDir, "batch.json"), `${JSON.stringify(doc, null, 2)}\n`);
	if (r.cast) await deps.writeFile(join(r.batchDir, "tui.cast"), r.cast.text());
	if (args.json) emit(ctx, true, doc, "");
	note(ctx, `warden batch: logs in ${r.logDir}${args.record ? `, recording in ${args.record}` : ""}`);
	if (args.tui && deps.terminal.isTTY) {
		const passed = r.summary.results.filter((j) => j.exitCode === 0).length;
		ctx.err(`warden batch: ${passed}/${r.total} passed, ${r.summary.failed.length} failed`);
	}
}

/** How a batch session ended: its exit code, and — once the jobs ran — the summary and where it lives. */
export type SessionResult = {
	code: number;
	batchDir?: string;
	summary?: BatchSummary;
	screenshots?: Screenshots;
	/** the log of each attempt (`attemptKey`): the failing run of that attempt when it failed */
	logs?: Logs;
	/** the `results.jsonl` of each attempt (`attemptKey`) whose job wrote one */
	resultFiles?: ResultFiles;
	/** every device the run leased, `worker` indexed */
	devices?: Array<{ worker: number; udid: string; name: string; leg?: string }>;
	/** per-device setup outcomes, when the session ran a setup */
	setups?: DeviceSetup[] | undefined;
};

/** Extras for callers building on batch (`warden e2e`). */
export type SessionHooks = {
	argvFor?: ArgvFor;
	name?: string;
	/** run once per device after the app install and before its first job; a device whose setup fails is dropped */
	setup?: DeviceSetupSpec | undefined;
	/** shut down the leased devices warden may shut down (see `shutdownReleasedDevices`) before releasing, when this says so of a finished, uninterrupted run */
	shutdownIf?: (summary: BatchSummary) => boolean;
	/** the flows the jobs run, tracked live from the jobs' `results.jsonl` */
	flows?: readonly TrackedFlow[];
	/** env added to one job's spawn (over the pool env, under the worker's own `WARDEN_UDID` / `WARDEN_WORKER` / `WARDEN_JOB…`) */
	jobEnv?: (job: JobEnvInput) => Record<string, string>;
	/**
	 * iOS: connect each device's socket helper and take one snapshot, in parallel, the moment the
	 * device is leased (alongside the app install, Metro and `setup`); that device's jobs get
	 * `WARDEN_SIMD_SOCKET` once the run is ready for them. Undefined = no warm-up. A failed warm-up
	 * only warns.
	 */
	warmDrivers?: WarmConnect | undefined;
	/**
	 * iOS without a warm-up: the socket of a helper already running for a device (undefined: none). That
	 * device's jobs get it as `WARDEN_SIMD_SOCKET`, so they do not each spawn a second helper beside it.
	 */
	residentSocket?: ((udid: string) => Promise<string | undefined>) | undefined;
};

/** What `hooks.jobEnv` knows about the spawn it is building. */
export type JobEnvInput = {
	job: string;
	worker: number;
	/** this run's number on its worker (retries included) */
	seq: number;
	/** 0 for a job's first run, 1 for its first retry… */
	attempt: number;
	udid: string;
	batchDir: string;
	/** the run's Metro, when it has one */
	metroUrl: string | undefined;
};

/** `hooks.shutdownIf`: stop the session's devices while their leases are still held; failures only warn. */
async function shutdownDevices(
	ctx: CommandContext,
	hooks: SessionHooks & { name: string },
	session: LeaseSession,
	summary: BatchSummary
): Promise<void> {
	if (!hooks.shutdownIf?.(summary)) return;
	const store = ctx.store();
	const leases = session.leaseIds.flatMap((id) => store.getLease(id) ?? []);
	const owner = resolveOwner(ctx);
	const { notes } = await withSpinner(ctx, "shutting down devices…", async (sctx, spinner) => {
		const outcome = await shutdownReleasedDevices(sctx, leases, owner);
		spinner.succeed(outcome.shutdown.length > 0 ? `shut down ${outcome.shutdown.join(" ")}` : "nothing to shut down");
		return outcome;
	});
	for (const line of notes) note(ctx, `warden ${hooks.name}: ${line}`);
}

/** Per-device setup (`hooks.setup`) of one pool: who is left to run jobs and every outcome. */
async function prepareDevices(
	ctx: CommandContext,
	deps: BatchDeps,
	name: string,
	spec: DeviceSetupSpec | undefined,
	devices: Device[],
	env: Record<string, string | undefined>,
	cwd: string,
	logDir: string,
	running: Set<ProcHandle>
): Promise<{ live: Device[]; setups?: DeviceSetup[] }> {
	if (!spec) return { live: devices };
	const setups = await setupDevices({
		devices,
		spec,
		env,
		cwd,
		logDir,
		spawn: (argv, o) => deps.spawn(argv, o),
		// recorded, so a later plain `warden claim` knows to restore the device
		slim: async (udid) => {
			const res = await deps.slim(udid);
			if (res.success) ctx.store().setSlimmed("ios", udid, ctx.now());
			return res;
		},
		track: (proc) => {
			const handle = proc as ProcHandle;
			running.add(handle);
			return () => running.delete(handle);
		},
	});
	for (const d of setups) {
		if (d.slim && "error" in d.slim) warn(ctx, `warden ${name}: slim ${d.udid}: ${d.slim.error}`);
		if (!d.ok) reportError(ctx, name, `setup failed on ${d.udid} (exit ${d.exitCode}) — log: ${d.log}`);
	}
	return { live: devices.filter((d) => setups.find((s) => s.worker === d.worker)?.ok), setups };
}

/** 130 when the run was interrupted, else 0 for a clean pass and 1 for any failure. */
const exitFor = (interrupted: boolean, passed: boolean): number => (interrupted ? 130 : passed ? 0 : 1);

/** One pool per claim: the legs' devices in claim order, `worker` counted across all of them. */
function buildPools(session: LeaseSession, args: BatchArgs): Pool[] {
	let worker = 0;
	return session.claims.map((claim, i): Pool => {
		const leg = args.legs?.[i];
		return {
			...(leg ? { leg: leg.name } : {}),
			env: leg?.env ?? {},
			devices: claim.claimed.map((c) => ({
				worker: worker++,
				udid: c.device.id,
				name: c.device.name,
				...(leg ? { leg: leg.name } : {}),
			})),
		};
	});
}

/**
 * A pool's env: the run env with `WARDEN_UDIDS` / `WARDEN_UDID_<i>` narrowed to the pool's own
 * devices (a leg's runner must not see another leg's), then the leg's env and `WARDEN_LEG`.
 */
function poolEnv(
	base: Record<string, string | undefined>,
	pool: Pool,
	devices: readonly Device[]
): Record<string, string | undefined> {
	const env = Object.fromEntries(Object.entries(base).filter(([key]) => !/^WARDEN_UDID_\d+$/.test(key)));
	env.WARDEN_UDIDS = devices.map((d) => d.udid).join(",");
	devices.forEach((d, i) => {
		env[`WARDEN_UDID_${i}`] = d.udid;
	});
	return { ...env, ...pool.env, ...(pool.leg !== undefined ? { WARDEN_LEG: pool.leg } : {}) };
}

/** The run's Metro, started the moment its port was leased; what the claim phase and `startServices` share. */
type MetroLaunch = {
	port: number;
	platform: Platform;
	log: string;
	/** `bundling` once the server answered; `up` once the bundle is warm; `failed` once anything went wrong */
	state: "starting" | "bundling" | "up" | "failed";
	/** never rejects */
	pending: Promise<Result<Metro>>;
	/** set once the server answered (before the prewarm): what `stop` kills even when the bundle failed */
	started: Metro | undefined;
	/** give up waiting (a failed claim, a signal), settle, kill whatever is running */
	stop: () => Promise<void>;
	/** `✔ Metro on :port serves root`, printed once wherever it is first observed */
	announce: (log: (line: string) => void) => void;
};

/**
 * Start the run's Metro on its leased port and prewarm the bundle without waiting for either: the
 * device claim (sims booting) and the app installs go on meanwhile, `awaitRunMetro` collects the
 * result. The server is called ready only once the port is verified to serve this project root.
 */
function launchRunMetro(
	ctx: CommandContext,
	deps: BatchDeps,
	plan: MetroPlan,
	o: {
		port: number;
		env: Record<string, string | undefined>;
		log: string;
		platform: Platform;
		interrupted: () => boolean;
	}
): MetroLaunch {
	let cancelled = false;
	let announced = false;
	const launch: MetroLaunch = {
		port: o.port,
		platform: o.platform,
		log: o.log,
		state: "starting",
		started: undefined,
		pending: Promise.resolve(err("Metro not started")),
		stop: async () => {
			cancelled = true;
			await launch.pending;
			const metro = launch.started;
			launch.started = undefined;
			await metro?.stop();
		},
		announce: (log) => {
			if (announced) return;
			announced = true;
			log(`${ctx.ui.color.green("✔")} Metro on :${o.port} serves ${plan.projectRoot}`);
		},
	};
	const run = async (): AsyncResult<Metro> => {
		const started = await startMetro(
			{
				probe: deps.metroProbe,
				now: ctx.now,
				sleep: deps.sleep,
				spawn: (cmd, env, cwd) => deps.spawn(cmd, { env, log: o.log, cwd, group: true, metro: true }),
				expoBin: (root) => resolveExpoBin(root, deps.which),
			},
			{
				projectRoot: plan.projectRoot,
				port: o.port,
				// CI: no interactive prompts (a busy port fails instead of asking) and no file watching
				env: { ...o.env, ...plan.env, CI: "1" },
				readyTimeoutMs: plan.readyTimeoutMs,
				aborted: () => cancelled || o.interrupted(),
			}
		);
		if (!started.success) return started;
		launch.started = started.data;
		if (plan.prewarm) {
			launch.state = "bundling";
			const warmed = await deps.prewarm(started.data.url, o.platform);
			if (!warmed.success) return warmed;
		}
		return started;
	};
	launch.pending = run()
		.catch((error: unknown) => err(error instanceof Error ? error.message : String(error)))
		.then((result) => {
			launch.state = result.success ? "up" : "failed";
			return result;
		});
	return launch;
}

/**
 * The early-started Metro's outcome: a spinner only while it is still starting (it usually is up
 * before the app installs finish); failures carry the log path.
 */
async function awaitRunMetro(ctx: CommandContext, launch: MetroLaunch): AsyncResult<Metro> {
	const settled = launch.state === "up" || launch.state === "failed";
	const metro = settled
		? await launch.pending
		: await withSpinner(ctx, `starting Metro on :${launch.port}…`, async (_sctx, spinner) => {
				if (launch.state === "bundling")
					spinner.update(`Metro on :${launch.port}: building the ${launch.platform} bundle…`);
				const result = await launch.pending;
				if (!result.success) spinner.fail("Metro not ready");
				return result;
			});
	if (!metro.success) return err(`${metro.error} (log: ${launch.log})`);
	launch.announce(ctx.err);
	return metro;
}

/**
 * Point every device at the run's Metro before its first job: Android gets the port reversed; iOS
 * relaunches the app with `--initialUrl` when its bundle id is known. Failures only warn — the
 * runner opens the app itself.
 */
async function openOnDevices(
	ctx: CommandContext,
	name: string,
	platform: Platform,
	plan: MetroPlan,
	metro: Metro,
	devices: readonly Device[]
): Promise<void> {
	const argvFor = (udid: string): string[] | undefined => {
		if (platform === "android") return adbReverseArgv(udid, metro.port);
		return plan.bundleId === undefined
			? undefined
			: devClientLaunchArgv(udid, plan.bundleId, metro.url, plan.launchArgs);
	};
	await Promise.all(
		devices.map(async (d) => {
			const argv = argvFor(d.udid);
			if (!argv) return;
			const res = await ctx.exec(argv);
			if (res.exitCode !== 0) warn(ctx, `warden ${name}: ${execError(argv, res)}`);
		})
	);
}

/** One scheduler per pool, run concurrently; their events feed one grid and their summaries merge. */
async function runPools(
	pools: readonly Queue[],
	o: { retry: number; now: () => number; signal: AbortSignal; onEvent: (e: BatchEvent) => void }
): Promise<BatchSummary> {
	const summaries = await Promise.all(
		pools.map((pool) =>
			runBatch({
				workers: pool.workers,
				jobs: pool.jobs,
				retry: o.retry,
				now: o.now,
				signal: o.signal,
				// each pool reports its own `done`; the run has one
				onEvent: (e) => {
					if (e.type !== "done") o.onEvent(e);
				},
				run: pool.run,
			})
		)
	);
	const stopped = summaries.some((s) => s.stopped);
	// a pool with no device left ran nothing: that is not a pass
	const ok = summaries.every((s) => s.ok) && pools.every((p) => p.workers.length > 0 || p.jobs.length === 0);
	o.onEvent({ type: "done", ok, stopped, at: o.now() });
	return { ok, stopped, results: summaries.flatMap((s) => s.results), failed: summaries.flatMap((s) => s.failed) };
}

/** What the phases of one supervised run share. */
type RunContext = {
	name: string;
	batchDir: string;
	logDir: string;
	platform: Platform;
	/** the first leased port (Metro's, when the run owns one) */
	port: number | undefined;
	pools: Pool[];
	devices: Device[];
	hooks: SessionHooks & { name: string };
	running: Set<ProcHandle>;
	interrupted: () => boolean;
	signal: AbortSignal;
};

/** The long-lived children of a run, stopped by `teardown`. */
type Services = {
	serve?: ProcHandle | undefined;
	metro?: Metro | undefined;
	recordings: Recording[];
	/** the warm socket helpers (`hooks.warmDrivers`) of the devices that run jobs */
	helpers?: WarmHelper[];
	/** the early warm-up while it has not been settled: `teardown` stops it */
	warm?: EarlyWarm | undefined;
};

/**
 * Collect the early warm-up (`hooks.warmDrivers`, started as each device was leased): its warnings
 * are printed now, the helpers of devices that dropped out in setup are stopped, and the others go
 * to `services` for `teardown`; fills `sockets` by udid for the devices that run jobs.
 */
async function settleWarm(
	ctx: CommandContext,
	r: RunContext,
	live: readonly Device[],
	warm: EarlyWarm,
	services: Services,
	sockets: Map<string, string>
): Promise<void> {
	services.warm = undefined;
	const done = await warm.settled();
	for (const line of done.warnings) ctx.err(ctx.ui.color.yellow(`warden ${r.name}: ${line}`));
	const running = new Set(live.map((d) => d.udid));
	const dropped = new Set(
		done.devices.flatMap((d) => (d.socketPath !== undefined && !running.has(d.udid) ? [d.socketPath] : []))
	);
	await Promise.all(done.helpers.filter((h) => dropped.has(h.socketPath)).map((h) => h.close().catch(() => {})));
	services.helpers = done.helpers.filter((h) => !dropped.has(h.socketPath));
	for (const d of done.devices) {
		if (d.socketPath !== undefined && running.has(d.udid)) sockets.set(d.udid, d.socketPath);
	}
}

/** No warm-up: the devices that run jobs and already have a running helper get its socket (never throws). */
async function residentSockets(
	live: readonly Device[],
	resident: (udid: string) => Promise<string | undefined>,
	sockets: Map<string, string>
): Promise<void> {
	await Promise.all(
		live.map(async (d) => {
			const socket = await resident(d.udid).catch(() => undefined);
			if (socket !== undefined) sockets.set(d.udid, socket);
		})
	);
}

/** Metro (started during the claim) → serve → recordings; resolves the job env + placeholder values once they are up. */
async function startServices(
	ctx: CommandContext,
	deps: BatchDeps,
	args: BatchArgs,
	r: RunContext,
	baseEnv: Record<string, string | undefined>,
	services: Services,
	metro: MetroLaunch | undefined
): AsyncResult<{ env: Record<string, string | undefined>; vars: RunVars }> {
	if (args.metro) {
		if (!metro) return err("metro: no port leased for it");
		const up = await awaitRunMetro(ctx, metro);
		// before the early return: a Metro whose bundle failed is still running, and teardown must kill it
		services.metro = metro.started;
		if (!up.success) return up;
	}
	const metroUrl = services.metro?.url;
	const vars: RunVars = {
		...(r.port !== undefined ? { port: r.port } : {}),
		...(metroUrl !== undefined ? { metroUrl } : {}),
	};
	const env = { ...baseEnv, ...(metroUrl !== undefined ? { WARDEN_METRO_URL: metroUrl } : {}) };
	if (args.serve) {
		const up = await startServe(ctx, deps, args.serve, { r, env, vars, cwd: args.cwd, services });
		if (!up.success) return up;
	}
	if (args.record) {
		const started = await startRecordings(deps, args.record, r.devices);
		if (!started.success) return started;
		services.recordings = started.data;
	}
	return ok({ env, vars });
}

/** Start serve (`{port}` / `{metroUrl}` substituted) and wait until it is ready. */
async function startServe(
	ctx: CommandContext,
	deps: BatchDeps,
	serve: Serve,
	o: { r: RunContext; env: Record<string, string | undefined>; vars: RunVars; cwd: string; services: Services }
): AsyncResult<void> {
	const log = join(o.r.logDir, "serve.log");
	const ready = serve.ready ? parseReadySpec(expandText(serve.ready.spec, o.vars), serve.ready.cwd) : ok(undefined);
	if (!ready.success) return ready;
	const proc = deps.spawn(["sh", "-c", expandText(serve.cmd, o.vars)], { env: o.env, log, group: true, cwd: o.cwd });
	o.services.serve = proc;
	const up = await waitReady(ctx, deps, serve, ready.data, proc, o.r.interrupted);
	return up.success ? up : err(`${up.error} (log: ${log})`);
}

type PreparedPool = { pool: Pool; live: Device[]; setups?: DeviceSetup[] };

/** Per-device setup of every pool, concurrently; `setups` is undefined when the run has no setup. */
async function preparePools(
	ctx: CommandContext,
	deps: BatchDeps,
	args: BatchArgs,
	r: RunContext,
	env: Record<string, string | undefined>
): Promise<{ prepared: PreparedPool[]; setups: DeviceSetup[] | undefined }> {
	const prepared = await Promise.all(
		r.pools.map(async (pool): Promise<PreparedPool> => {
			const setupEnv = poolEnv(env, pool, pool.devices);
			const { setup } = r.hooks;
			const done = await prepareDevices(
				ctx,
				deps,
				r.name,
				setup,
				pool.devices,
				setupEnv,
				args.cwd,
				r.logDir,
				r.running
			);
			return { pool, ...done };
		})
	);
	return { prepared, setups: r.hooks.setup ? prepared.flatMap((p) => p.setups ?? []) : undefined };
}

/** `rows`: the grid's rows (every live device). */
type Queue = { workers: Device[]; rows: Device[]; jobs: string[]; run: ReturnType<typeof jobRunner> };

/** One job queue per pool: its workers (one per device) and its job runner. */
function poolQueues(
	ctx: CommandContext,
	deps: BatchDeps,
	args: BatchArgs,
	r: RunContext,
	prepared: readonly PreparedPool[],
	o: {
		jobs: string[];
		cmd: string[];
		env: Record<string, string | undefined>;
		vars: RunVars;
		screenshots: Map<string, string>;
		logs: Map<string, string>;
		resultFiles: Map<string, string>;
		sockets: ReadonlyMap<string, string>;
	}
): Queue[] {
	const qualified = r.pools.length > 1;
	const onTimeout = (job: string, w: BatchWorker) => {
		const after = formatDuration(args.jobTimeoutMs ?? 0);
		reportError(ctx, r.name, `${job} still running on ${w.udid} after ${after} — killing it`);
	};
	return prepared.map((p) => ({
		workers: p.live,
		rows: p.live,
		jobs: o.jobs.map((job) => legJob(job, qualified ? p.pool.leg : undefined)),
		run: jobRunner(deps, {
			cmd: o.cmd,
			env: poolEnv(o.env, p.pool, p.live),
			pool: p.pool,
			live: p.live,
			qualified,
			vars: o.vars,
			cwd: args.cwd,
			batchDir: r.batchDir,
			logDir: r.logDir,
			passes: args.passes,
			platform: r.platform,
			jobTimeoutMs: args.jobTimeoutMs,
			onTimeout,
			screenshots: o.screenshots,
			logs: o.logs,
			resultFiles: o.resultFiles,
			sockets: o.sockets,
			running: r.running,
			interrupted: r.interrupted,
			hooks: r.hooks,
		}),
	}));
}

/** The run env before Metro is up: lease env + preset / suite env + `WARDEN_BATCH_DIR` / `WARDEN_PORT`. */
function runEnv(session: LeaseSession, args: BatchArgs, batchDir: string): Record<string, string | undefined> {
	const port = session.ports[0]?.port;
	return {
		...session.env,
		...args.env,
		WARDEN_BATCH_DIR: batchDir,
		...(port !== undefined ? { WARDEN_PORT: String(port) } : {}),
	};
}

/**
 * Headless iOS: close any simulator window that attached after the claim hid them. A simulator the
 * claim booted can show its window late; one that was already running had its window (or none)
 * settled when the claim hid it, so when the claim booted nothing there is nothing new to look for.
 */
async function hideLateWindows(
	ctx: CommandContext,
	deps: BatchDeps,
	args: BatchArgs,
	r: RunContext,
	session: LeaseSession,
	live: readonly Device[]
): Promise<void> {
	if (r.platform !== "ios" || !args.flags.headless || bootedByClaim(session.outcome).length === 0) return;
	const warn = (line: string) => ctx.err(ctx.ui.color.yellow(`warden ${r.name}: ${line}`));
	await hideSimWindows({ exec: ctx.exec, sleep: deps.sleep, warn }, live);
}

/** What `runSession` sets up before the claim and `supervise` carries on with. */
type RunSetup = {
	batchId: string;
	batchDir: string;
	logDir: string;
	/** aborted by SIGINT / SIGTERM, from the claim on */
	controller: AbortController;
	/** the run's Metro, launched on the port lease (undefined: no `metro` plan, or no port) */
	metro: MetroLaunch | undefined;
	/** the iOS driver warm-up, started per leg as its devices were leased (undefined: no `warmDrivers` hook, or not iOS) */
	warm: EarlyWarm | undefined;
};

/** Everything after the claim: Metro → serve → recordings → setup → jobs → stop serve / recordings / Metro → batch.json → release. */
async function supervise(
	ctx: CommandContext,
	deps: BatchDeps,
	args: BatchArgs,
	jobs: string[],
	cmd: string[],
	session: LeaseSession,
	hooks: SessionHooks & { name: string },
	run: RunSetup
): Promise<SessionResult> {
	const { batchId, batchDir, logDir, controller } = run;
	const pools = buildPools(session, args);
	const r: RunContext = {
		name: hooks.name,
		batchDir,
		logDir,
		platform: args.flags.request.platform,
		port: session.ports[0]?.port,
		pools,
		devices: pools.flatMap((p) => p.devices),
		hooks,
		running: new Set<ProcHandle>(),
		interrupted: () => controller.signal.aborted,
		signal: controller.signal,
	};
	const screenshots = new Map<string, string>();
	const logs = new Map<string, string>();
	const resultFiles = new Map<string, string>();
	const sockets = new Map<string, string>();
	const stopHold = holdLeases(ctx, deps, session.leaseIds, (signal) => {
		controller.abort();
		for (const job of r.running) job.kill(signal);
	});
	const services: Services = { recordings: [], warm: run.warm };
	const fail = (message: string, extra: Partial<SessionResult> = {}): SessionResult => {
		reportError(ctx, r.name, message);
		return { code: r.interrupted() ? 130 : 1, ...extra };
	};
	/** workers are done: serve first, then the recordings (the contract's stop order), Metro last */
	const teardown = async () => {
		const { serve, metro, recordings, warm } = services;
		const helpers = [...(services.helpers ?? [])];
		services.serve = undefined;
		services.metro = undefined;
		services.recordings = [];
		services.helpers = [];
		services.warm = undefined;
		if (warm) {
			// a run that ended before it collected the warm-up: stop waiting for it and close what came up
			warm.abort();
			helpers.push(...(await warm.settled()).helpers);
		}
		if (serve) await stopServe(deps, serve);
		await Promise.all(recordings.map((rec) => rec.stop()));
		await Promise.all(helpers.map((helper) => helper.close().catch(() => {})));
		await metro?.stop();
	};
	try {
		await deps.mkdir(logDir);
		const up = await startServices(ctx, deps, args, r, runEnv(session, args, batchDir), services, run.metro);
		if (!up.success) return fail(up.error, { batchDir });
		const { env, vars } = up.data;
		const { prepared, setups } = await preparePools(ctx, deps, args, r, env);
		const live = prepared.flatMap((p) => p.live);
		if (live.length === 0) {
			const failedLogs = (setups ?? []).filter((d) => !d.ok).map((d) => d.log);
			return fail(`setup failed on every device (logs: ${failedLogs.join(", ")})`, { batchDir, setups });
		}
		// independent of each other: the dev client's first launch loads the bundle while a late window closes
		const metroPlan = args.metro;
		const metroUp = services.metro;
		await Promise.all([
			metroPlan && metroUp ? openOnDevices(ctx, r.name, r.platform, metroPlan, metroUp, live) : undefined,
			hideLateWindows(ctx, deps, args, r, session, live),
		]);
		if (run.warm) await settleWarm(ctx, r, live, run.warm, services, sockets);
		else if (hooks.residentSocket && r.platform === "ios") await residentSockets(live, hooks.residentSocket, sockets);
		const queues = poolQueues(ctx, deps, args, r, prepared, {
			jobs,
			cmd,
			env,
			vars,
			screenshots,
			logs,
			resultFiles,
			sockets,
		});
		const total = queues.reduce((n, q) => n + q.jobs.length, 0);
		const startedAt = ctx.now();
		const { summary, screen } = await runGrid(ctx, deps, args, r, queues, {
			total,
			startedAt,
			resultFiles,
			flows: hooks.flows,
		});
		const endedAt = ctx.now();
		screen.end();
		await teardown();
		const { devices } = r;
		const done: BatchRun = { batchId, batchDir, logDir, cmd, devices, total, startedAt, endedAt, summary, screenshots };
		await report(ctx, deps, args, screen.cast ? { ...done, cast: screen.cast } : done);
		if (!r.interrupted()) await shutdownDevices(ctx, hooks, session, summary);
		return {
			code: exitFor(r.interrupted(), summary.ok),
			batchDir,
			summary,
			screenshots,
			logs,
			resultFiles,
			devices,
			setups,
		};
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	} finally {
		await teardown();
		stopHold();
		await session.release();
	}
}

/** Operands before `--` (at most one: platform or preset) + the command after it (may be empty). */
function batchOperands(
	argv: readonly string[],
	operands: readonly string[]
): Result<{ target?: string; cmd: string[] }> {
	const { cmd } = splitCommand(argv);
	const before = operands.slice(0, Math.max(0, operands.length - cmd.length));
	if (before.length > 1) return err(`unexpected arguments before --: ${before.slice(1).join(" ")}`);
	const [target] = before;
	return ok(target === undefined ? { cmd } : { target, cmd });
}

/** `ios` / `android` / nothing (picker) → a platform; anything else is a `batches.<name>` preset. */
async function resolveTarget(
	ctx: CommandContext,
	target: string | undefined
): AsyncResult<{ platform: Platform; preset?: BatchPreset }> {
	if (target === undefined || target === "ios" || target === "android") {
		const platform = await resolvePlatform(ctx, target);
		return platform.success ? ok({ platform: platform.data }) : platform;
	}
	const stopAt = (await readGitFacts(ctx.exec, ctx.cwd, ctx.git))?.toplevel;
	const found = findBatchPreset({ start: ctx.cwd, name: target, ...(stopAt ? { stopAt } : {}) });
	if (!found.success) return found;
	const { preset, names } = found.data;
	if (!preset) {
		const known = names.length > 0 ? `, presets: ${names.join(", ")}` : "";
		return err(`unknown platform or preset "${target}" (ios|android${known})`);
	}
	return ok({ platform: preset.platform, preset });
}

/** A preset as option values (paths already absolute, so the invoking cwd doesn't touch them). */
function presetOpts(preset: BatchPreset): Partial<BatchOpts> {
	const str = (n: number | undefined) => (n === undefined ? undefined : String(n));
	const values: Partial<BatchOpts> = {
		profile: preset.profile,
		runtime: preset.runtime,
		count: str(preset.count),
		max: str(preset.max),
		wait: preset.wait,
		ttl: preset.ttl,
		label: preset.label,
		port: preset.ports,
		retry: str(preset.retry),
		passes: str(preset.passes),
		serve: preset.serve,
		serveReady: preset.serveReady,
		serveTimeout: preset.serveTimeout,
		record: preset.record,
		logs: preset.logs,
		...(preset.app ? { app: true, project: preset.projectRoot } : {}),
		...(preset.app && preset.installMode !== undefined ? { installMode: preset.installMode } : {}),
		...(preset.app && preset.resetKeychain ? { resetKeychain: true } : {}),
		...(preset.app && preset.variant !== undefined ? { variant: preset.variant } : {}),
	};
	return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
}

/**
 * Precedence: flags passed on the command line > preset > commander defaults. A CLI `--jobs` /
 * `--jobs-from` replaces the preset's jobs source.
 */
export function mergePreset(
	preset: BatchPreset,
	opts: BatchOpts,
	passed: ReadonlySet<string>
): { opts: BatchOpts; base: BatchBase } {
	const cli = Object.fromEntries(Object.entries(opts).filter(([key]) => passed.has(key)));
	const cliJobs = passed.has("jobs") || passed.has("jobsFrom");
	return {
		opts: { ...opts, ...presetOpts(preset), ...cli },
		base: {
			cwd: preset.cwd,
			...(preset.env ? { env: preset.env } : {}),
			...(preset.jobs && !cliJobs ? { jobs: preset.jobs } : {}),
		},
	};
}

const clampFlags = (flags: ClaimFlags, jobCount: number): ClaimFlags =>
	jobCount >= flags.request.count ? flags : { ...flags, request: { ...flags.request, count: Math.max(1, jobCount) } };

/**
 * More devices than jobs would idle: claim at most one device per job, per leg (same `args` when no
 * change).
 */
export function clampToJobs(args: BatchArgs, jobCount: number): BatchArgs {
	const flags = clampFlags(args.flags, jobCount);
	const legs = args.legs?.map((leg) => ({ ...leg, flags: clampFlags(leg.flags, jobCount) }));
	const unchanged = flags === args.flags && (legs ?? []).every((leg, i) => leg.flags === args.legs?.[i]?.flags);
	return unchanged ? args : { ...args, flags, ...(legs ? { legs } : {}) };
}

/** Parse → load jobs → claim (under a spinner) → supervise; exit 0 only when every job passed. */
async function batch(
	ctx: CommandContext,
	deps: BatchDeps,
	operands: readonly string[],
	opts: BatchOpts,
	passed: ReadonlySet<string>
): Promise<number> {
	const fail = (message: string) => {
		reportError(ctx, "batch", message);
		return 1;
	};
	const split = batchOperands(ctx.argv, operands);
	if (!split.success) return fail(split.error);
	const target = await resolveTarget(ctx, split.data.target);
	if (!target.success) return fail(target.error);
	const { platform, preset } = target.data;
	const cmd = split.data.cmd.length > 0 ? split.data.cmd : (preset?.cmd ?? []);
	if (cmd.length === 0) return fail("missing command after -- (warden batch ios -- <cmd…>)");
	const merged = preset ? mergePreset(preset, opts, passed) : { opts, base: {} };
	const headless = resolveHeadless({
		flag: passed.has("headless") ? opts.headless : undefined,
		config: preset?.headless,
		env: ctx.env,
	});
	const args = parseBatchArgs(platform, { ...merged.opts, headless }, ctx.cwd, merged.base);
	if (!args.success) return fail(args.error);
	const jobs = await loadJobs(ctx, deps, args.data);
	if (!jobs.success) return fail(jobs.error);
	return (await runSession(ctx, deps, args.data, jobs.data, cmd)).code;
}

/** A warm-up the run never collected (the claim failed, a signal): stop waiting for it and close what came up. */
async function closeWarm(warm: EarlyWarm | undefined): Promise<void> {
	if (!warm) return;
	warm.abort();
	const { helpers } = await warm.settled();
	await Promise.all(helpers.map((helper) => helper.close().catch(() => {})));
}

/**
 * Claim (at most one device per job, under a spinner) → supervise → release. With a `metro` plan the
 * run's Metro is launched the moment its port is leased, so it starts and prewarms while the devices
 * boot and the app installs; until `supervise` holds the leases, SIGINT / SIGTERM abort the claim and
 * stop that Metro (a detached process, which the terminal's Ctrl-C would otherwise leave on the port).
 */
export async function runSession(
	ctx: CommandContext,
	deps: BatchDeps,
	args: BatchArgs,
	jobs: string[],
	cmd: string[],
	hooks: SessionHooks = {}
): Promise<SessionResult> {
	const name = hooks.name ?? "batch";
	const lease = clampToJobs(args, jobs.length);
	if (lease !== args) note(ctx, `warden ${name}: ${jobs.length} job(s) → claiming ${jobs.length} device(s)`);
	const owner = resolveOwner(ctx);
	const { platform } = lease.flags.request;
	const wanted = (lease.legs?.map((leg) => leg.flags) ?? [lease.flags])
		.map((flags) => `${flags.request.count} ${flags.request.profile}`)
		.join(" + ");
	const batchId = deps.newId();
	const batchDir = lease.record ?? join(wardenHome(ctx.env), "batches", batchId);
	const logDir = lease.logs ?? join(batchDir, "logs");
	const controller = new AbortController();
	const interrupted = () => controller.signal.aborted;
	let launch: MetroLaunch | undefined;
	let claimDone = false;
	// each leg's devices are warmed the moment they are leased, so it overlaps the install and Metro
	const warm =
		hooks.warmDrivers && platform === "ios"
			? startEarlyWarm({
					connect: hooks.warmDrivers,
					legCounts: (lease.legs?.map((leg) => leg.flags) ?? [lease.flags]).map((flags) => flags.request.count),
					logDir,
					now: ctx.now,
					after: deps.after,
					writeFile: deps.writeFile,
					signal: controller.signal,
				})
			: undefined;
	const offSignals = (["SIGINT", "SIGTERM"] as const).map((signal) =>
		deps.onSignal(signal, () => {
			controller.abort();
			void launch?.stop();
		})
	);
	const claimed = await withSpinner(ctx, `claiming ${wanted} ${platform} device(s)…`, async (sctx, spinner) => {
		const legFlags = lease.legs?.map((leg) => leg.flags);
		const progress = leasedProgress(spinner, ctx.ui.color, lease.app !== undefined);
		const onLeased =
			progress || warm
				? (outcome: ClaimOutcome, leg: number) => {
						progress?.(outcome);
						warm?.leased(outcome, leg);
					}
				: undefined;
		const plan = lease.metro;
		const onPorts = plan
			? (ports: RunPort[]) => {
					const port = ports[0]?.port;
					if (port === undefined) return;
					launch = launchRunMetro(sctx, deps, plan, {
						port,
						platform,
						log: join(batchDir, "metro.log"),
						env: { ...ctx.env, ...lease.env, WARDEN_BATCH_DIR: batchDir, WARDEN_PORT: String(port) },
						interrupted,
					});
					// up before the claim is done: say so above the claim spinner (the overlap is the point)
					void launch.pending.then((result) => {
						if (result.success && !claimDone) launch?.announce(sctx.err);
					});
				}
			: undefined;
		const aborted = () => interrupted() || launch?.state === "failed";
		const args = {
			...lease,
			...(legFlags ? { legFlags } : {}),
			...(onLeased ? { onLeased } : {}),
			...(onPorts ? { onPorts } : {}),
			aborted,
		};
		const result = await claimAll(sctx, deps, owner, args, name);
		claimDone = true;
		// after claimAll: the run's own leases keep the background gc off its devices (12-2, 16-1)
		maybeAutoGc(ctx);
		if (!result.success) spinner.fail(lease.app ? "claim / app install failed" : "claim failed");
		else if (lease.app) spinner.succeed(`app ready on ${result.data.outcome.claimed.length} device(s)`);
		else spinner.succeed(leasedText(result.data.outcome));
		return result;
	});
	// before supervise re-subscribes (holdLeases), so the two never share a handler slot
	for (const off of offSignals) off();
	if (!claimed.success || interrupted()) {
		await closeWarm(warm);
		if (claimed.success) await claimed.data.release();
		await launch?.stop();
		const metro = launch ? await launch.pending : undefined;
		const claimError = claimed.success || claimed.error === INTERRUPTED ? undefined : claimed.error;
		const metroError = launch && metro && !metro.success ? `${metro.error} (log: ${launch.log})` : undefined;
		const reason = claimError ?? (interrupted() ? INTERRUPTED : (metroError ?? INTERRUPTED));
		reportError(ctx, name, reason);
		return { code: interrupted() ? 130 : 1 };
	}
	return supervise(
		ctx,
		deps,
		lease,
		jobs,
		cmd,
		claimed.data,
		{ ...hooks, name },
		{
			batchId,
			batchDir,
			logDir,
			controller,
			metro: launch,
			warm,
		}
	);
}

/** Queue options shared by `warden batch` and `warden e2e`. */
export function withBatchOptions<Args extends unknown[], Opts extends OptionValues, Globals extends OptionValues>(
	cmd: Commander<Args, Opts, Globals>
) {
	return cmd
		.option("--retry <n>", "re-run a failed job up to N times on the same device", "0")
		.option("--passes <n>", "a job passes after N consecutive green runs on its device", "1")
		.option(
			"--serve <sh-cmd>",
			"start this (sh -c, own process group) before the jobs; killed at the end; {port} = the first leased port"
		)
		.option("--serve-ready <probe>", "wait for http://…, tcp:PORT or file:PATH before starting jobs (tcp:{port} works)")
		.option("--serve-timeout <duration>", "--serve-ready: give up after this long", "10m")
		.option("--job-timeout <duration>", "kill a job still running after this long (it counts as failed)")
		.option("--record <dir>", "iOS: record every simulator + the TUI into DIR (batch.json, tui.cast, dev-<i>.mp4)")
		.option("--logs <dir>", "per-job logs (default: <record dir>/logs or $WARDEN_HOME/batches/<id>/logs)")
		.option("--no-tui", "plain log lines instead of the live grid");
}

/**
 * `warden batch [platform|preset] [claim options] (--jobs …|--jobs-from …) [--serve …] [--record dir] [-- <cmd…>]`.
 * A preset is `batches.<name>` in `warden.config.ts`; flags passed alongside it override it.
 */
export function createBatchCommand(deps: BatchDeps): Command {
	return defineCommand({
		name: "batch",
		group: "Run",
		summary: "claim N devices, fan a job queue out over them (one worker per device), release at the end",
		register: (cmd, ctx, done) => {
			withBatchOptions(
				withLeaseOptions(
					withClaimOptions(
						cmd
							.argument(
								"[platform]",
								"ios | android (asked for when omitted in a terminal), or a warden.config.ts batches preset"
							)
							.argument("[cmd...]", "per-job command after --; {job} {udid} {worker} {seq} are substituted")
					)
				)
			)
				.option("--jobs <list>", "comma-separated jobs")
				.option("--jobs-from <file>", "one job per line from a file, or - for stdin")
				.addHelpText(
					"after",
					"\nExamples:\n  warden batch ios --count 3 --jobs a,b,c,d -- bun e2e --flow {job} --device {udid}\n  warden batch e2e --count 2    # batches.e2e from warden.config.ts, --count overridden"
				)
				.action(async (platform, rest, opts, command) => {
					const passed = new Set(Object.keys(opts).filter((key) => command.getOptionValueSource(key) === "cli"));
					done(await batch(ctx, deps, platform === undefined ? rest : [platform, ...rest], opts, passed));
				});
		},
	});
}

/** how long an exited job's output may still be draining into its log */
const LOG_DRAIN_MS = 2000;
/** an exited job's pipes that stay silent this long are held open by a grandchild: stop waiting on them */
const LOG_QUIET_MS = 250;

export const defaultBatchDeps: BatchDeps = {
	pid: process.pid,
	isPortFree: (port) => isPortFree(port),
	spawn(cmd, opts) {
		const log = openStampedLog(opts.log);
		try {
			const proc = Bun.spawn(cmd, {
				env: { ...opts.env, WARDEN_LOG_TIMESTAMPS: "1" },
				cwd: opts.cwd,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				detached: opts.group === true,
			});
			void log.pump(proc.stdout);
			void log.pump(proc.stderr);
			return {
				// a grandchild still holding the pipes can't hold up the exit: silent for LOG_QUIET_MS, or LOG_DRAIN_MS at most
				exited: proc.exited.then(async (code) => {
					await log.drained({ quietMs: LOG_QUIET_MS, maxMs: LOG_DRAIN_MS });
					log.close();
					return exitCodeOf(proc, code);
				}),
				kill: (signal) => {
					try {
						if (opts.group) process.kill(-proc.pid, signal);
						else proc.kill(signal);
					} catch {
						// already gone
					}
				},
			};
		} catch (e) {
			log.close();
			throw e;
		}
	},
	probe: probeReady,
	sleep: (ms) => Bun.sleep(ms),
	record: (udid, path) => startSimRecording(udid, path, Date.now),
	screenshot: captureScreenshot,
	slim: (udid) => slimSimulator(bunExec, udid),
	writeFile: async (path, data) => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, data);
	},
	readFile: (path) => readFile(path, "utf8"),
	readFrom: readFileFrom,
	mkdir: async (dir) => {
		await mkdir(dir, { recursive: true });
	},
	newId: () => `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`,
	terminal: {
		isTTY: process.stderr.isTTY === true,
		get columns() {
			return process.stderr.columns || 100;
		},
		write: (data) => {
			process.stderr.write(data);
		},
	},
	onSignal: processOnSignal,
	every: intervalEvery,
	after: (ms, fn) => {
		const timer = setTimeout(fn, ms);
		return () => clearTimeout(timer);
	},
	metroProbe: (port, projectRoot) => metroOwner(bunExec, port, projectRoot),
	prewarm: prewarmMetro,
	warmConnect,
	residentSocket,
	which: (cmd) => Bun.which(cmd),
	resolveModule: (specifier, from) => Bun.resolveSync(specifier, from),
	helperDir: () => helperDir(Bun.main, process.execPath),
};

export const batchCommand: Command = createBatchCommand(defaultBatchDeps);
