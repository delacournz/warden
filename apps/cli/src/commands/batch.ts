import { closeSync, mkdirSync, openSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Command as Commander, OptionValues } from "@commander-js/extra-typings";
import { expandArgv, expandText, jobSlug, parseJobLines, parseJobList } from "@delacour/warden-core/batch/expand";
import { type BatchJobsSource, type BatchPreset, findBatchPreset } from "@delacour/warden-core/batch/preset";
import { type BatchEvent, type BatchSummary, type BatchWorker, runBatch } from "@delacour/warden-core/batch/schedule";
import { formatDuration, parseDuration } from "@delacour/warden-core/duration";
import { bunExec, execError } from "@delacour/warden-core/exec";
import { isPortFree } from "@delacour/warden-core/ports";
import { slimSimulator } from "@delacour/warden-core/sims/slim";
import { wardenHome } from "@delacour/warden-core/store";
import type { Platform } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { maybeAutoGc } from "../autogc";
import { type Cast, createCast } from "../batch/cast";
import { type Recording, startSimRecording, videoName } from "../batch/record";
import { captureScreenshot } from "../batch/screenshot";
import { parseReadySpec, probeReady, type ReadySpec } from "../batch/serve";
import { type DeviceSetup, type DeviceSetupSpec, setupDevices } from "../batch/setup";
import { applyEvent, type BatchView, initialView, type LiveScreen, liveScreen, plainLine, render } from "../batch/tui";
import {
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
import {
	type AppFlagValues,
	claimAll,
	exitCodeOf,
	type ForwardedSignal,
	holdLeases,
	intervalEvery,
	type LeaseArgs,
	type LeaseSession,
	type LeaseSessionDeps,
	parseAppFlags,
	processOnSignal,
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
	startMetro,
} from "../metro";
import { emit } from "../output";
import { withSpinner } from "../spinner-context";

export type KillSignal = ForwardedSignal | "SIGKILL";

export type ProcHandle = { exited: Promise<number>; kill: (signal: KillSignal) => void };

export type SpawnOptions = {
	env: Record<string, string | undefined>;
	/** stdout + stderr are appended to this file */
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
	mkdir: (dir: string) => Promise<void>;
	newId: () => string;
	terminal: Terminal;
	/** run `fn` once after `ms` (job timeouts); returns cancel */
	after: (ms: number, fn: () => void) => () => void;
	/** who serves the run's Metro port, relative to the project root */
	metroProbe: (port: number, projectRoot: string) => Promise<MetroOwner>;
	/** build the bundle once before the first job */
	prewarm: (url: string, platform: Platform) => AsyncResult<{ bundled: boolean }>;
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

/** A validated `warden batch` run (what `runSession` takes); `warden e2e` adds legs, `single` and `metro`. */
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
	/** one job process per leg, handed the whole pool (`WARDEN_UDIDS`), instead of one worker per device */
	single?: boolean;
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
const FRAME_MS = 100;

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
	screenshots: Screenshots
) {
	return {
		batchId,
		cmd,
		startedAt,
		endedAt,
		ok: summary.ok,
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
type Display = { event: (e: BatchEvent) => void; end: () => void; cast?: Cast };

function display(ctx: CommandContext, deps: BatchDeps, args: BatchArgs, view: { current: BatchView }): Display {
	const { terminal } = deps;
	const live = args.tui && terminal.isTTY;
	const width = live ? terminal.columns : 100;
	// header + one row per device + the cursor row the grid's trailing newline leaves
	const cast = args.record
		? createCast({ width, height: view.current.devices.length + 2, startedAt: ctx.now() })
		: undefined;
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
			if (!live) {
				const text = plainLine(view.current, e);
				if (text !== undefined) ctx.err(text);
			}
			frame(false);
		},
		end: () => {
			stopFrames();
			frame(true);
		},
	};
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

/** Per-job argv before `{job}` `{udid}` `{worker}` `{seq}` expansion (default: the batch command). */
export type ArgvFor = (job: string) => string[];

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
	single: boolean;
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

/**
 * The per-job `run` for `runBatch`: expand the argv, spawn with the job env + log, track it for
 * SIGINT. With `passes` > 1 the job is spawned again after each green run (`WARDEN_PASS`, one log
 * per pass); the first red run is the attempt's exit code. A job past `jobTimeoutMs` is shot,
 * then killed, and its attempt exits `TIMEOUT_EXIT`.
 */
function jobRunner(deps: BatchDeps, o: JobRunnerOptions) {
	const { leg } = o.pool;
	const baseJob = (id: string) => (o.qualified && leg !== undefined ? id.slice(0, -(leg.length + 1)) : id);
	/** the device(s) of a failed attempt, next to its log (`….log` → `….png`, further pool devices `….<i>.png`); never throws */
	const shoot = async (w: BatchWorker, seq: number, log: string): Promise<void> => {
		const key = attemptKey({ worker: w.worker, seq });
		const targets = o.single ? o.live : [w];
		await Promise.all(
			targets.map(async (device, i) => {
				const path = log.replace(/\.log$/, i === 0 ? ".png" : `.${i}.png`);
				try {
					if ((await deps.screenshot(o.platform, device.udid, path)) && !o.screenshots.has(key))
						o.screenshots.set(key, path);
				} catch {
					// best effort
				}
			})
		);
	};
	/** env, argv and log of one spawn: the pool env + this worker's own agent-device state dir */
	const plan = (w: BatchWorker, id: string, seq: number, pass: number) => {
		const job = baseJob(id);
		const stateDir = o.env.AGENT_DEVICE_STATE_DIR ?? join(o.batchDir, "agent-device", String(w.worker));
		const env = {
			...o.env,
			AGENT_DEVICE_STATE_DIR: stateDir,
			WARDEN_UDID: w.udid,
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
			stateDir,
			...o.vars,
			...(leg !== undefined ? { leg } : {}),
		};
		const argv = expandArgv(o.hooks.argvFor ? o.hooks.argvFor(job) : o.cmd, vars);
		return { job, env, log, argv };
	};
	const spawnOnce = async (w: BatchWorker, id: string, seq: number, pass: number): Promise<number> => {
		const { job, env, log, argv } = plan(w, id, seq, pass);
		o.logs.set(attemptKey({ worker: w.worker, seq }), log);
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
	return async (w: BatchWorker, job: string, seq: number): Promise<number> => {
		for (let pass = 0; pass < o.passes; pass++) {
			const code = await spawnOnce(w, job, seq, pass);
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
	const doc = summaryJson(r.batchId, r.cmd, r.startedAt, r.endedAt, r.devices, r.summary, r.screenshots);
	await deps.writeFile(join(r.batchDir, "batch.json"), `${JSON.stringify(doc, null, 2)}\n`);
	if (r.cast) await deps.writeFile(join(r.batchDir, "tui.cast"), r.cast.text());
	if (args.json) emit(ctx, true, doc, "");
	ctx.err(ctx.ui.color.dim(`warden batch: logs in ${r.logDir}${args.record ? `, recording in ${args.record}` : ""}`));
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
	for (const note of notes) ctx.err(ctx.ui.color.dim(`warden ${hooks.name}: ${note}`));
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
		if (d.slim && "error" in d.slim) ctx.err(ctx.ui.color.yellow(`warden ${name}: slim ${d.udid}: ${d.slim.error}`));
		if (!d.ok)
			ctx.err(ctx.ui.color.red(`warden ${name}: setup failed on ${d.udid} (exit ${d.exitCode}) — log: ${d.log}`));
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

/** Start the run's Metro on its leased port (verified to serve this project) and prewarm the bundle. */
async function startRunMetro(
	ctx: CommandContext,
	deps: BatchDeps,
	plan: MetroPlan,
	o: {
		port: number | undefined;
		env: Record<string, string | undefined>;
		log: string;
		platform: Platform;
		interrupted: () => boolean;
		started: (metro: Metro) => void;
	}
): AsyncResult<Metro> {
	if (o.port === undefined) return err("metro: no port leased for it");
	const metro = await withSpinner(ctx, `starting Metro on :${o.port}…`, async (_sctx, spinner) => {
		const started = await startMetro(
			{
				probe: deps.metroProbe,
				now: ctx.now,
				sleep: deps.sleep,
				spawn: (cmd, env, cwd) => deps.spawn(cmd, { env, log: o.log, cwd, group: true, metro: true }),
			},
			{
				projectRoot: plan.projectRoot,
				port: o.port ?? 0,
				// CI: no interactive prompts (a busy port fails instead of asking) and no file watching
				env: { ...o.env, ...plan.env, CI: "1" },
				readyTimeoutMs: plan.readyTimeoutMs,
				aborted: o.interrupted,
			}
		);
		if (!started.success) {
			spinner.fail("Metro not ready");
			return started;
		}
		o.started(started.data);
		if (plan.prewarm) {
			spinner.update(`Metro on :${o.port}: building the ${o.platform} bundle…`);
			const warmed = await deps.prewarm(started.data.url, o.platform);
			if (!warmed.success) {
				spinner.fail("Metro could not build the bundle");
				return warmed;
			}
		}
		spinner.succeed(`Metro on :${o.port} serves ${plan.projectRoot}`);
		return started;
	});
	return metro.success ? metro : err(`${metro.error} (log: ${o.log})`);
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
			if (res.exitCode !== 0) ctx.err(ctx.ui.color.yellow(`warden ${name}: ${execError(argv, res)}`));
		})
	);
}

/** The grid row of a pool's worker: in `single` mode one row stands for the whole pool. */
function workerRows(live: readonly Device[], single: boolean): Device[] {
	const [first, ...rest] = live;
	if (!single || !first) return [...live];
	return [{ ...first, name: rest.length > 0 ? `${first.name} +${rest.length}` : first.name }];
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
type Services = { serve?: ProcHandle | undefined; metro?: Metro | undefined; recordings: Recording[] };

/** Metro → serve → recordings; resolves the job env + placeholder values once they are up. */
async function startServices(
	ctx: CommandContext,
	deps: BatchDeps,
	args: BatchArgs,
	r: RunContext,
	baseEnv: Record<string, string | undefined>,
	services: Services
): AsyncResult<{ env: Record<string, string | undefined>; vars: RunVars }> {
	if (args.metro) {
		const started = await startRunMetro(ctx, deps, args.metro, {
			port: r.port,
			env: baseEnv,
			log: join(r.batchDir, "metro.log"),
			platform: r.platform,
			interrupted: r.interrupted,
			started: (metro) => {
				services.metro = metro;
			},
		});
		if (!started.success) return started;
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

type Queue = { workers: Device[]; jobs: string[]; run: ReturnType<typeof jobRunner> };

/** One job queue per pool: its workers (one per device, or one for the pool in `single` mode) and its job runner. */
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
	}
): Queue[] {
	const qualified = r.pools.length > 1;
	const single = args.single === true;
	const onTimeout = (job: string, w: BatchWorker) => {
		const after = formatDuration(args.jobTimeoutMs ?? 0);
		ctx.err(ctx.ui.color.red(`warden ${r.name}: ${job} still running on ${w.udid} after ${after} — killing it`));
	};
	return prepared.map((p) => ({
		workers: workerRows(p.live, single),
		jobs: o.jobs.map((job) => legJob(job, qualified ? p.pool.leg : undefined)),
		run: jobRunner(deps, {
			cmd: o.cmd,
			env: poolEnv(o.env, p.pool, p.live),
			pool: p.pool,
			live: p.live,
			qualified,
			single,
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
			running: r.running,
			interrupted: r.interrupted,
			hooks: r.hooks,
		}),
	}));
}

/** The run env before Metro is up: lease env + preset / suite env + `WARDEN_BATCH_DIR` / `WARDEN_PORT`. */
function runEnv(session: LeaseSession, args: BatchArgs, batchDir: string): Record<string, string | undefined> {
	// the invoking shell's agent-device state dir must not leak into the jobs: each worker gets its own
	const { AGENT_DEVICE_STATE_DIR: _shared, ...sessionEnv } = session.env;
	const port = session.ports[0]?.port;
	return {
		...sessionEnv,
		...args.env,
		WARDEN_BATCH_DIR: batchDir,
		...(port !== undefined ? { WARDEN_PORT: String(port) } : {}),
	};
}

/** Everything after the claim: Metro → serve → recordings → setup → jobs → stop serve / recordings / Metro → batch.json → release. */
async function supervise(
	ctx: CommandContext,
	deps: BatchDeps,
	args: BatchArgs,
	jobs: string[],
	cmd: string[],
	session: LeaseSession,
	hooks: SessionHooks & { name: string }
): Promise<SessionResult> {
	const batchId = deps.newId();
	const batchDir = args.record ?? join(wardenHome(ctx.env), "batches", batchId);
	const logDir = args.logs ?? join(batchDir, "logs");
	const controller = new AbortController();
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
	const stopHold = holdLeases(ctx, deps, session.leaseIds, (signal) => {
		controller.abort();
		for (const job of r.running) job.kill(signal);
	});
	const services: Services = { recordings: [] };
	const fail = (message: string, extra: Partial<SessionResult> = {}): SessionResult => {
		ctx.err(ctx.ui.color.red(`warden ${r.name}: ${message}`));
		return { code: r.interrupted() ? 130 : 1, ...extra };
	};
	/** workers are done: serve first, then the recordings (the contract's stop order), Metro last */
	const teardown = async () => {
		const { serve, metro, recordings } = services;
		services.serve = undefined;
		services.metro = undefined;
		services.recordings = [];
		if (serve) await stopServe(deps, serve);
		await Promise.all(recordings.map((rec) => rec.stop()));
		await metro?.stop();
	};
	try {
		await deps.mkdir(logDir);
		const up = await startServices(ctx, deps, args, r, runEnv(session, args, batchDir), services);
		if (!up.success) return fail(up.error, { batchDir });
		const { env, vars } = up.data;
		const { prepared, setups } = await preparePools(ctx, deps, args, r, env);
		const live = prepared.flatMap((p) => p.live);
		if (live.length === 0) {
			const failedLogs = (setups ?? []).filter((d) => !d.ok).map((d) => d.log);
			return fail(`setup failed on every device (logs: ${failedLogs.join(", ")})`, { batchDir, setups });
		}
		if (args.metro && services.metro) await openOnDevices(ctx, r.name, r.platform, args.metro, services.metro, live);
		const queues = poolQueues(ctx, deps, args, r, prepared, { jobs, cmd, env, vars, screenshots, logs });
		const total = queues.reduce((n, q) => n + q.jobs.length, 0);
		const startedAt = ctx.now();
		const rows = queues.flatMap((q) => q.workers);
		const screen = display(ctx, deps, args, { current: initialView(rows, total, startedAt) });
		const summary = await runPools(queues, {
			retry: args.retry,
			now: ctx.now,
			signal: r.signal,
			onEvent: screen.event,
		});
		const endedAt = ctx.now();
		screen.end();
		await teardown();
		const { devices } = r;
		const run: BatchRun = { batchId, batchDir, logDir, cmd, devices, total, startedAt, endedAt, summary, screenshots };
		await report(ctx, deps, args, screen.cast ? { ...run, cast: screen.cast } : run);
		if (!r.interrupted()) await shutdownDevices(ctx, hooks, session, summary);
		return { code: exitFor(r.interrupted(), summary.ok), batchDir, summary, screenshots, logs, devices, setups };
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	} finally {
		await teardown();
		stopHold();
		session.release();
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
	const top = await ctx.exec(["git", "rev-parse", "--show-toplevel"], { cwd: ctx.cwd });
	const stopAt = top.exitCode === 0 && top.stdout.trim() ? top.stdout.trim() : undefined;
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
		...(preset.app && preset.clean ? { clean: true } : {}),
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
 * change). A `single` run hands its one job the whole pool, so nothing is clamped.
 */
export function clampToJobs(args: BatchArgs, jobCount: number): BatchArgs {
	if (args.single) return args;
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
	const { color } = ctx.ui;
	const fail = (message: string) => {
		ctx.err(color.red(`warden batch: ${message}`));
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
	const args = parseBatchArgs(platform, merged.opts, ctx.cwd, merged.base);
	if (!args.success) return fail(args.error);
	const jobs = await loadJobs(ctx, deps, args.data);
	if (!jobs.success) return fail(jobs.error);
	return (await runSession(ctx, deps, args.data, jobs.data, cmd)).code;
}

/** Claim (at most one device per job, under a spinner) → supervise → release. */
export async function runSession(
	ctx: CommandContext,
	deps: BatchDeps,
	args: BatchArgs,
	jobs: string[],
	cmd: string[],
	hooks: SessionHooks = {}
): Promise<SessionResult> {
	const { color } = ctx.ui;
	const name = hooks.name ?? "batch";
	const lease = clampToJobs(args, jobs.length);
	if (lease !== args) ctx.err(color.dim(`warden ${name}: ${jobs.length} job(s) → claiming ${jobs.length} device(s)`));
	const owner = resolveOwner(ctx);
	maybeAutoGc(ctx);
	const { platform } = lease.flags.request;
	const wanted = (lease.legs?.map((leg) => leg.flags) ?? [lease.flags])
		.map((flags) => `${flags.request.count} ${flags.request.profile}`)
		.join(" + ");
	const claimed = await withSpinner(ctx, `claiming ${wanted} ${platform} device(s)…`, async (sctx, spinner) => {
		const legFlags = lease.legs?.map((leg) => leg.flags);
		const result = await claimAll(sctx, deps, owner, legFlags ? { ...lease, legFlags } : lease, name);
		if (result.success) spinner.succeed(`leased ${result.data.outcome.claimed.map((c) => c.device.name).join(", ")}`);
		else spinner.fail("claim failed");
		return result;
	});
	if (!claimed.success) {
		ctx.err(color.red(`warden ${name}: ${claimed.error}`));
		return { code: 1 };
	}
	return supervise(ctx, deps, lease, jobs, cmd, claimed.data, { ...hooks, name });
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

export const defaultBatchDeps: BatchDeps = {
	pid: process.pid,
	isPortFree: (port) => isPortFree(port),
	spawn(cmd, opts) {
		mkdirSync(dirname(opts.log), { recursive: true });
		const fd = openSync(opts.log, "a");
		try {
			const proc = Bun.spawn(cmd, {
				env: opts.env,
				cwd: opts.cwd,
				stdin: "ignore",
				stdout: fd,
				stderr: fd,
				detached: opts.group === true,
			});
			return {
				exited: proc.exited.then((code) => exitCodeOf(proc, code)),
				kill: (signal) => {
					try {
						if (opts.group) process.kill(-proc.pid, signal);
						else proc.kill(signal);
					} catch {
						// already gone
					}
				},
			};
		} finally {
			closeSync(fd);
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
};

export const batchCommand: Command = createBatchCommand(defaultBatchDeps);
