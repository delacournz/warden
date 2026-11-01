import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Command as Commander, OptionValues } from "@commander-js/extra-typings";
import { type Metro, type MetroOwner, MetroRunner, metroTools } from "@delacour/warden-builds/metro";
import { durationParser } from "@delacour/warden-config/duration";
import type { SlimProfile } from "@delacour/warden-config/slim.profile";
import {
	type ElasticPlan,
	ElasticPlanner,
	type LateWorker,
	lateWorkerClaimer,
} from "@delacour/warden-core/batch/elastic";
import { batchJobs } from "@delacour/warden-core/batch/expand";
import { type BatchJobsSource, type BatchPreset, batchPresets } from "@delacour/warden-core/batch/preset";
import {
	type BatchEvent,
	type BatchHandle,
	type BatchSummary,
	type BatchWorker,
	batchScheduler,
} from "@delacour/warden-core/batch/schedule";
import { ENV_NAMES } from "@delacour/warden-e2e/env";
import { CapacityDepsBuilder } from "@delacour/warden-leasing/capacity-deps";
import type { ClaimedDevice, ClaimOutcome } from "@delacour/warden-leasing/claim";
import { claimRequestRules } from "@delacour/warden-leasing/claim-request";
import { ReleasedDeviceShutdown } from "@delacour/warden-leasing/device-shutdown";
import { headlessResolver } from "@delacour/warden-leasing/headless";
import { ownerResolver } from "@delacour/warden-leasing/owner";
import { portProbe } from "@delacour/warden-leasing/ports";
import { PRIORITY } from "@delacour/warden-leasing/queue";
import {
	type ForwardedSignal,
	INTERRUPTED,
	type LeaseArgs,
	LeaseHeartbeat,
	type LeaseSession,
	type LeaseSessionDeps,
	LeaseSessionRunner,
	type RunPort,
	sessionRules,
	sessionSignals,
} from "@delacour/warden-leasing/session";
import { SimWindowHider } from "@delacour/warden-leasing/sim-windows";
import { SimSlimmer } from "@delacour/warden-providers/slim";
import { execErrors, processExec } from "@delacour/warden-runtime/exec";
import { gitFactsReader } from "@delacour/warden-runtime/git-facts";
import { storeLocator } from "@delacour/warden-store/store";
import { leaseModel, type Owner, type Platform } from "@delacour/warden-store/types";
import { type AsyncResult, type Result, resultFactory } from "@delacour/warden-types/result";
import { uiHelperSweep } from "../agent-ui/helper-sweep";
import { UI_ERROR_EXIT, type UiErrorCode } from "../agent-ui/output";
import { uiStopHelperAfter } from "../agent-ui/stop-helper-after";
import { autoGc } from "../autogc";
import { type Cast, castHelpers } from "../batch/cast";
import { type EarlyWarm, earlyWarmHelpers } from "../batch/early-warm";
import { batchRecord, type Recording } from "../batch/record";
import { type ReadFrom, resultsTailHelpers } from "../batch/results-tail";
import { type RunnerReport, runnerReportHelpers } from "../batch/runner-report";
import { screenshotHelpers } from "../batch/screenshot";
import { batchServe, type ReadySpec } from "../batch/serve";
import { batchSetup, type DeviceSetup, type DeviceSetupSpec, type EarlySlim } from "../batch/setup";
import { specPollerHelpers } from "../batch/spec-poller";
import type { SpecMark, TrackedSpec } from "../batch/spec-progress";
import { stampedLogHelpers } from "../batch/stamped-log";
import { type BatchView, type LiveScreen, tuiHelpers } from "../batch/tui";
import type { WarmConnect, WarmHelper } from "../batch/warm-drivers";
import { warmGateHelpers } from "../batch/warm-gate";
import { type ClaimFlags, type ClaimFlagValues, claimFlagsHelpers, type PhysicalOptionValues } from "../claim-flags";
import { CliCommand, type CommandNode } from "../command";
import { type CommandContext, contextBuilder } from "../context";
import { bunRunner } from "../e2e/bun-runner";
import { e2eRuntime } from "../e2e/e2e-runtime";
import { warmConnectHelpers } from "../e2e/warm-connect";
import { leaseHostBuilder } from "../lease-host";
import { type AppFlagValues, leaseOptions } from "../lease-options";
import { output } from "../output";
import { physicalLock } from "../physical-lock";
import { physicalPickHelpers } from "../physical-pick";
import { spinnerContext } from "../spinner-context";
import type { Spinner } from "../ui";
import { buildInfoHelpers } from "../update/build-info";

export type KillSignal = ForwardedSignal | "SIGKILL";

export type ProcHandle = {
	exited: Promise<number>;
	kill: (signal: KillSignal) => void;
	/** once `exited` has settled: how long (ms) its log took to drain after the exit (a grandchild holding the pipes shows here) */
	logDrainMs?: () => number | undefined;
};

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
	/** `slim`: switch off the unneeded daemons on one iOS simulator (resolves to the jobs touched); `profile` keeps categories / labels running */
	slim: (udid: string, profile?: SlimProfile) => AsyncResult<string[]>;
	/** write a file, creating its parent dirs */
	writeFile: (path: string, data: string) => Promise<void>;
	readFile: (path: string) => Promise<string>;
	/** a file from a byte offset on: how the spec poller reads only what a `results.jsonl` gained */
	readFrom: ReadFrom;
	mkdir: (dir: string) => Promise<void>;
	newId: () => string;
	terminal: Terminal;
	/** run `fn` once after `ms` (job timeouts); returns cancel */
	after: (ms: number, fn: () => void) => () => void;
	/** who serves the run's Metro port, relative to the project root */
	metroProbe: (port: number, projectRoot: string) => Promise<MetroOwner>;
	/** build the bundle once before the first job; `signal` (Ctrl-C, a failed claim, `stop`) ends it at once */
	prewarm: (url: string, platform: Platform, signal?: AbortSignal) => AsyncResult<{ bundled: boolean }>;
	/** how `hooks.warmDrivers` reaches one device's socket helper (default: `e2e/warm-connect`) */
	warmConnect: (ctx: CommandContext) => WarmConnect;
	/** a device's running resident helper socket, for `hooks.residentSocket` when there is no warm-up (default: `e2e/warm-connect`) */
	residentSocket?: (ctx: CommandContext) => (udid: string) => Promise<string | undefined>;
	/** `Bun.which`: where a command is on PATH */
	which: (cmd: string) => string | null | undefined;
	/** this process's executable: a compiled warden runs the specs as bun itself (`process.execPath`) */
	execPath: () => string;
	/** `Bun.resolveSync`: the file a package specifier resolves to from `from` (throws when it does not) */
	resolveModule: (specifier: string, from: string) => string;
	/** the published version of the `@delacour/warden-e2e` that owns a resolved preload (`undefined`: workspace sources) */
	e2eVersion: (preloadPath: string) => string | undefined;
	/** extract the `@delacour/warden-e2e` copy this warden ships and return its preload (repos without the dependency) */
	bundledE2e: (ctx: CommandContext) => AsyncResult<string>;
	/** where the spec drivers' native helper lives next to this warden (`WARDEN_HELPER_DIR`) */
	helperDir: () => string;
};

/** Commander option values of `warden batch`. */
export type BatchOpts = ClaimFlagValues &
	AppFlagValues &
	PhysicalOptionValues & {
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

/** Exit code of a job killed for running past `jobTimeoutMs` (as `timeout(1)`). */
export const TIMEOUT_EXIT = 124;

const SERVE_KILL_GRACE_MS = 15_000;
/** SIGTERM → SIGKILL for a timed-out job. */
const JOB_KILL_GRACE_MS = 5_000;
const READY_POLL_MS = 500;
/** the grid is redrawn this often, and at once on every event: what changes between events is the clocks, which show whole seconds */
const FRAME_MS = 1_000;

/** What a preset adds beyond option values: its jobs source, env and cwd. */
export type BatchBase = { jobs?: BatchJobsSource; env?: Record<string, string>; cwd?: string };

type Device = BatchWorker & {
	name: string;
	/** a real phone/tablet: never rebooted, slimmed, arranged or shut down (`WARDEN_DEVICE_KIND=physical`) */
	physical?: true;
	/** the device's lease (`WARDEN_LEASE_ID` for its jobs) */
	leaseId?: string;
	video?: string;
	videoStartedAt?: number;
	leg?: string;
	/** an elastic worker: ms after the run started that it joined */
	joinedAfterMs?: number;
};

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

/** How long each attempt's log drained after its exit (`attemptKey` → ms, summed over passes). */
export type LogDrains = ReadonlyMap<string, number>;

/** TUI sinks: the terminal (live grid or plain lines) and the `tui.cast` mirror. */
type Display = {
	event: (e: BatchEvent) => void;
	/** spec results read off `worker`'s spec output */
	specs: (worker: number, marks: Readonly<Record<string, SpecMark>>) => void;
	/** finished tests, one line each (`--no-tui` only: the grid shows specs) */
	tests: (lines: readonly string[]) => void;
	/** the spec runner's report: the specs each device ran */
	report: (report: RunnerReport) => void;
	end: () => void;
	/** a pool that became ready after the grid started: its devices' rows (12-3) */
	rows: (rows: ReadonlyArray<{ worker: number; udid: string; name: string }>) => void;
	cast?: Cast;
};

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
	/** a device's helper socket for its jobs, asked by each spawn: the first one waits for that device's own warm-up (12-3) */
	socketFor: (udid: string) => Promise<string | undefined>;
	/** filled with how long each attempt's log drained after its exit (`attemptKey`, summed over passes) */
	drains?: Map<string, number>;
	running: Set<ProcHandle>;
	interrupted: () => boolean;
};

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
	drains?: LogDrains;
	cast?: Cast;
};

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
	/** why the run stopped before any job: a phone whose runner would not start (`device_locked`, ...) */
	error?: { code: string; message: string; udid: string };
};

/** Extras for callers building on batch (`warden e2e`). */
export type SessionHooks = {
	argvFor?: ArgvFor;
	name?: string;
	/** run once per device after the app install and before its first job; a device whose setup fails is dropped */
	setup?: DeviceSetupSpec | undefined;
	/** shut down the leased devices warden may shut down (see `shutdownReleasedDevices`) before releasing, when this says so of a finished, uninterrupted run */
	shutdownIf?: (summary: BatchSummary) => boolean;
	/** the specs the jobs run, tracked live from the jobs' `results.jsonl` */
	specs?: readonly TrackedSpec[];
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
	/** with `passes` > 1: 0 for the attempt's first spawn, 1 for its second green run… (`WARDEN_PASS`) */
	pass?: number;
	udid: string;
	batchDir: string;
	/** the run's Metro, when it has one */
	metroUrl: string | undefined;
};

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

/** warden's own dev-client launch gets the spec driver's launch bound (`LAUNCH_MS`): a hung `simctl launch` cannot hold the run (12-6) */
const OPEN_LAUNCH_MS = 30_000;

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
	/** devices the headless hide could not boot again (`LeaseSession.lost`): kept in the pools, never recorded */
	lost: readonly string[];
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
	/** the early warm-up (`hooks.warmDrivers`): `teardown` stops it and closes its helpers */
	warm?: EarlyWarm | undefined;
	/** warm helpers closed already (a device dropped before its jobs): `teardown` skips them */
	closed: Set<WarmHelper>;
};

type PreparedPool = { pool: Pool; live: Device[]; setups?: DeviceSetup[] };

/** `rows`: the grid's rows (every live device). */
type Queue = { workers: Device[]; rows: Device[]; jobs: string[]; run: ReturnType<BatchCommand["jobRunner"]> };

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
	/** the iOS slim, started per device as it was leased (undefined: the suite does not slim) */
	slim: EarlySlim<ClaimedDevice> | undefined;
	/** capacity-limited run: the workers still to claim in the background, one at a time (undefined: all claimed up front) */
	elastic: { plan: ElasticPlan; flags: ClaimFlags } | undefined;
};

/** What `claimLateWorker` shares with the run: the pools it prepared and the devices that may join. */
type LateSink = { prepared: PreparedPool[]; devices: Map<number, Device> };

/** The elastic workers of a run: start the background claims, admit each into the grid as it joins. */
type ElasticRun = {
	start: (queue: Queue, handle: BatchHandle) => void;
	join: (worker: number) => Device | undefined;
	/** every late worker's preparation, for the setup report */
	prepared: PreparedPool[];
	/** the background claims are over (they end on their own once the queue is drained or the run aborted) */
	settled: () => Promise<unknown>;
};

/** A run without elastic workers. */
const NO_ELASTIC: ElasticRun = { start: () => {}, join: () => undefined, prepared: [], settled: async () => {} };

/** What the session's signal handler and claim callbacks share: the Metro launched mid-claim and whether the claim ended. */
type SessionRun = { launch: MetroLaunch | undefined; claimDone: boolean };

/** how long an exited job's output may still be draining into its log */
const LOG_DRAIN_MS = 2000;
/** an exited job's pipes that stay silent this long are held open by a grandchild: stop waiting on them */
const LOG_QUIET_MS = 250;

export const defaultBatchDeps: BatchDeps = {
	pid: process.pid,
	isPortFree: (port) => portProbe.isFree(port),
	spawn(cmd, opts) {
		const log = stampedLogHelpers.openStampedLog(opts.log);
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
			let drainMs: number | undefined;
			return {
				// a grandchild still holding the pipes can't hold up the exit: silent for LOG_QUIET_MS, or LOG_DRAIN_MS at most
				exited: proc.exited.then(async (code) => {
					drainMs = await log.drained({ quietMs: LOG_QUIET_MS, maxMs: LOG_DRAIN_MS });
					log.close();
					return sessionRules.exitCodeOf(proc, code);
				}),
				logDrainMs: () => drainMs,
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
	probe: batchServe.probeReady.bind(batchServe),
	sleep: (ms) => Bun.sleep(ms),
	record: (udid, path) => batchRecord.startSimRecording(udid, path, Date.now),
	screenshot: screenshotHelpers.captureScreenshot.bind(screenshotHelpers),
	slim: (udid, profile) => new SimSlimmer(processExec.run).slim(udid, profile ? { profile } : {}),
	writeFile: async (path, data) => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, data);
	},
	readFile: (path) => readFile(path, "utf8"),
	readFrom: resultsTailHelpers.readFileFrom.bind(resultsTailHelpers),
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
	onSignal: sessionSignals.onSignal,
	every: sessionSignals.every,
	after: (ms, fn) => {
		const timer = setTimeout(fn, ms);
		return () => clearTimeout(timer);
	},
	metroProbe: (port, projectRoot) => metroTools.owner(processExec.run, port, projectRoot),
	prewarm: (url, platform, signal) => metroTools.prewarm(url, platform, signal),
	warmConnect: (ctx) => warmConnectHelpers.warmConnect(ctx),
	residentSocket: (ctx) => warmConnectHelpers.residentSocket(ctx),
	which: (cmd) => Bun.which(cmd),
	execPath: () => process.execPath,
	resolveModule: (specifier, from) => Bun.resolveSync(specifier, from),
	e2eVersion: e2eRuntime.readE2ePackageVersion.bind(e2eRuntime),
	bundledE2e: (ctx) => e2eRuntime.stageBundledRuntime(ctx.env, buildInfoHelpers.currentBuild()),
	helperDir: () => bunRunner.helperDir(Bun.main, process.execPath),
};

export class BatchCommand extends CliCommand {
	override readonly name = "batch";
	override readonly group = "Run";
	override readonly summary =
		"claim N devices, fan a job queue out over them (one worker per device), release at the end";

	constructor(private readonly deps: BatchDeps) {
		super();
	}

	protected register(cmd: CommandNode, ctx: CommandContext, done: (code: number) => void): void {
		this.withBatchOptions(
			leaseOptions.withLeaseOptions(
				claimFlagsHelpers.withPhysicalOptions(
					claimFlagsHelpers.withClaimOptions(
						cmd
							.argument(
								"[platform]",
								"ios | android (asked for when omitted in a terminal), or a warden.config.ts batches preset"
							)
							.argument("[cmd...]", "per-job command after --; {job} {udid} {worker} {seq} are substituted")
					)
				)
			)
		)
			.option("--jobs <list>", "comma-separated jobs")
			.option("--jobs-from <file>", "one job per line from a file, or - for stdin")
			.addHelpText(
				"after",
				"\nExamples:\n  warden batch ios --count 3 --jobs a,b,c,d -- bun e2e --spec {job} --device {udid}\n  warden batch e2e --count 2    # batches.e2e from warden.config.ts, --count overridden"
			)
			.action(async (platform, rest, opts, command) => {
				const passed = new Set(Object.keys(opts).filter((key) => command.getOptionValueSource(key) === "cli"));
				done(await this.batch(ctx, this.deps, platform === undefined ? rest : [platform, ...rest], opts, passed));
			});
	}

	/** The id a job runs under in the scheduler: qualified with its leg when the run has several. */
	legJob(job: string, leg: string | undefined): string {
		return leg === undefined ? job : `${job}@${leg}`;
	}

	private absolute(cwd: string, path: string) {
		return isAbsolute(path) ? path : resolve(cwd, path);
	}

	/** `--jobs` / `--jobs-from` (exactly one, else the preset's source) → where the jobs come from. */
	private parseJobsSource(opts: BatchOpts, cwd: string, fallback?: BatchJobsSource): Result<BatchJobsSource> {
		if (opts.jobs === undefined && opts.jobsFrom === undefined && fallback) return resultFactory.ok(fallback);
		if ((opts.jobs === undefined) === (opts.jobsFrom === undefined))
			return resultFactory.err("pass exactly one of --jobs / --jobs-from");
		if (opts.jobsFrom !== undefined)
			return resultFactory.ok(
				opts.jobsFrom === "-" ? { kind: "stdin" } : { kind: "file", path: this.absolute(cwd, opts.jobsFrom) }
			);
		const jobs = batchJobs.parseList(opts.jobs ?? "");
		return jobs.length > 0 ? resultFactory.ok({ kind: "list", jobs }) : resultFactory.err("--jobs is empty");
	}

	/** `--serve` / `--serve-ready` / `--serve-timeout` → serve config (undefined without `--serve`). */
	private parseServe(opts: BatchOpts, cwd: string): Result<Serve | undefined> {
		if (opts.serve === undefined)
			return opts.serveReady === undefined
				? resultFactory.ok(undefined)
				: resultFactory.err("--serve-ready needs --serve");
		const timeoutMs = durationParser.parse(opts.serveTimeout);
		if (!timeoutMs.success) return resultFactory.err(`--serve-timeout: ${timeoutMs.error}`);
		if (opts.serveReady === undefined) return resultFactory.ok({ cmd: opts.serve, timeoutMs: timeoutMs.data });
		// validated now with stand-in values; parsed for real once the port is leased
		const ready = batchServe.parseReadySpec(
			batchJobs.expand(opts.serveReady, { port: 1, metroUrl: "http://127.0.0.1:1" }),
			cwd
		);
		if (!ready.success) return ready;
		return resultFactory.ok({ cmd: opts.serve, timeoutMs: timeoutMs.data, ready: { spec: opts.serveReady, cwd } });
	}

	/** `--retry` / `--passes` / `--job-timeout` → validated numbers. */
	private parseLimits(opts: BatchOpts): Result<Pick<BatchArgs, "retry" | "passes" | "jobTimeoutMs">> {
		if (!/^\d+$/.test(opts.retry)) return resultFactory.err(`--retry must be an integer >= 0, got "${opts.retry}"`);
		if (!/^\d+$/.test(opts.passes) || Number(opts.passes) < 1)
			return resultFactory.err(`--passes must be an integer >= 1, got "${opts.passes}"`);
		const jobTimeout =
			opts.jobTimeout === undefined ? resultFactory.ok(undefined) : durationParser.parse(opts.jobTimeout);
		if (!jobTimeout.success) return resultFactory.err(`--job-timeout: ${jobTimeout.error}`);
		return resultFactory.ok({
			retry: Number(opts.retry),
			passes: Number(opts.passes),
			...(jobTimeout.data !== undefined ? { jobTimeoutMs: jobTimeout.data } : {}),
		});
	}

	/**
	 * Validated batch args from the resolved platform + option values (nothing is claimed yet).
	 * Relative option paths resolve against `cwd` (the invoking dir); serve / jobs run in `base.cwd ?? cwd`.
	 */
	parseBatchArgs(platform: Platform, opts: BatchOpts, cwd: string, base: BatchBase = {}): Result<BatchArgs> {
		const flags = claimFlagsHelpers.parseClaimFlags(
			platform,
			claimFlagsHelpers.withNamedPhysical(opts),
			undefined,
			undefined,
			PRIORITY.low
		);
		if (!flags.success) return flags;
		const app = leaseOptions.parseAppFlags(opts);
		if (!app.success) return app;
		const jobs = this.parseJobsSource(opts, cwd, base.jobs);
		if (!jobs.success) return jobs;
		const limits = this.parseLimits(opts);
		if (!limits.success) return limits;
		const serve = this.parseServe(opts, cwd);
		if (!serve.success) return serve;
		if (opts.record !== undefined && platform !== "ios") return resultFactory.err("--record is iOS-only");
		return resultFactory.ok({
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
			...(opts.record !== undefined ? { record: this.absolute(cwd, opts.record) } : {}),
			...(opts.logs !== undefined ? { logs: this.absolute(cwd, opts.logs) } : {}),
		});
	}

	/** `jobsFrom: { command }`: `sh -c` in the batch cwd; stdout lines are the jobs. */
	private async commandJobs(ctx: CommandContext, args: BatchArgs, command: string): AsyncResult<string[]> {
		const cmd = ["sh", "-c", command];
		const res = await ctx.exec(cmd, { cwd: args.cwd, env: { ...ctx.env, ...args.env } });
		if (res.exitCode !== 0) return resultFactory.err(`jobsFrom.command: ${execErrors.format(cmd, res)}`);
		const jobs = batchJobs.parseLines(res.stdout);
		return jobs.length > 0
			? resultFactory.ok(jobs)
			: resultFactory.err(`jobsFrom.command: no jobs from \`${command}\``);
	}

	private async loadJobs(ctx: CommandContext, deps: BatchDeps, args: BatchArgs): AsyncResult<string[]> {
		const source = args.jobs;
		if (source.kind === "list") return resultFactory.ok(source.jobs);
		if (source.kind === "command") return this.commandJobs(ctx, args, source.command);
		try {
			const jobs = batchJobs.parseLines(
				source.kind === "stdin" ? await ctx.readStdin() : await deps.readFile(source.path)
			);
			return jobs.length > 0 ? resultFactory.ok(jobs) : resultFactory.err("--jobs-from: no jobs");
		} catch (error) {
			return resultFactory.err(`--jobs-from: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** SIGTERM the serve group, SIGKILL after the grace period. */
	private async stopServe(deps: BatchDeps, serve: ProcHandle): Promise<void> {
		const exited = serve.exited.then(() => true);
		const waitExit = () => Promise.race([exited, deps.sleep(SERVE_KILL_GRACE_MS).then(() => false)]);
		serve.kill("SIGTERM");
		if (await waitExit()) return;
		serve.kill("SIGKILL");
		await waitExit();
	}

	/** Poll `ready` until it passes; fails when serve exits first, on timeout, or when `aborted`. */
	private async waitReady(
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
		if (!ready) return resultFactory.ok(undefined);
		const deadline = ctx.now() + serve.timeoutMs;
		for (;;) {
			if (aborted()) return resultFactory.err("interrupted while waiting for serve");
			if (await deps.probe(ready)) return resultFactory.ok(undefined);
			await Promise.resolve();
			if (exitCode !== undefined) return resultFactory.err(`serve exited (${exitCode}) before ready`);
			if (ctx.now() >= deadline)
				return resultFactory.err(`serve not ready after ${Math.round(serve.timeoutMs / 1000)}s`);
			await deps.sleep(READY_POLL_MS);
		}
	}

	/** Key of one job attempt in `Screenshots` / `Logs`. */
	attemptKey(r: { worker: number; seq: number }) {
		return `${r.worker}:${r.seq}`;
	}

	/** The `batch.json` document (record-dir contract; also the `--json` output). */
	private summaryJson(
		batchId: string,
		cmd: string[],
		startedAt: number,
		endedAt: number,
		devices: Device[],
		summary: BatchSummary,
		screenshots: Screenshots,
		headless: boolean,
		drains?: LogDrains
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
				...(d.joinedAfterMs !== undefined ? { joinedAfterMs: d.joinedAfterMs } : {}),
				...(d.video !== undefined ? { video: d.video, videoStartedAt: d.videoStartedAt } : {}),
			})),
			jobs: summary.results.map((r) => ({
				...(screenshots.has(this.attemptKey(r)) ? { screenshot: screenshots.get(this.attemptKey(r)) } : {}),
				job: r.job,
				worker: r.worker,
				udid: r.udid,
				seq: r.seq,
				attempt: r.attempt,
				startedAt: r.startedAt,
				endedAt: r.endedAt,
				exitCode: r.exitCode,
				...(drains?.has(this.attemptKey(r)) ? { logDrainMs: Math.round(drains.get(this.attemptKey(r)) ?? 0) } : {}),
			})),
		};
	}

	private display(
		ctx: CommandContext,
		deps: BatchDeps,
		args: BatchArgs,
		view: { current: BatchView },
		specs: readonly TrackedSpec[] | undefined,
		/** what the cast is sized for: the grid once every pool is in it (default: the first frame) */
		sized: BatchView = view.current
	): Display {
		const { terminal } = deps;
		const live = args.tui && terminal.isTTY;
		const width = live ? terminal.columns : 100;
		// the grid (header, device rows, spec lines) + the cursor row its trailing newline leaves
		const height = tuiHelpers.render(sized, { width, color: false }).split("\n").length + 1;
		const cast = args.record ? castHelpers.createCast({ width, height, startedAt: ctx.now() }) : undefined;
		const sinks: Array<{ screen: LiveScreen; color: boolean; last?: string }> = [];
		if (live) sinks.push({ screen: tuiHelpers.liveScreen(terminal.write), color: ctx.ui.color.level > 0 });
		if (cast) sinks.push({ screen: tuiHelpers.liveScreen((data) => cast.write(ctx.now(), data)), color: true });
		const frame = (final: boolean) => {
			view.current = { ...view.current, now: ctx.now() };
			for (const sink of sinks) {
				const text = tuiHelpers.render(view.current, { width, color: sink.color });
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
				view.current = tuiHelpers.applyEvent(view.current, e);
				if (e.type === "job-start") {
					const ids = this.shardSpecIds(specs, e.job);
					if (ids.length > 0) view.current = tuiHelpers.addRunnerSpecs(view.current, e.worker, ids);
				}
				if (!live) {
					const text = tuiHelpers.plainLine(view.current, e);
					if (text !== undefined) ctx.err(text);
				}
				frame(false);
			},
			specs: (worker, marks) => {
				if (!live) this.announceSpecs(ctx, view.current, worker, marks);
				view.current = tuiHelpers.applySpecMarks(view.current, worker, marks);
				frame(false);
			},
			tests: (lines) => {
				if (!live) for (const line of lines) ctx.err(line);
			},
			report: (report) => {
				view.current = tuiHelpers.applyRunnerReport(view.current, report);
				if (!live) this.announceDevices(ctx, view.current);
				frame(false);
			},
			end: () => {
				stopFrames();
				frame(true);
			},
			rows: (rows) => {
				const added = tuiHelpers.initialView(rows, 0, 0).devices;
				const { runners } = view.current;
				// a sharded grid tracks specs per runner: the late pool's workers need theirs (R1)
				const fresh = [...new Set(added.map((d) => d.worker))].filter((w) => !runners?.some((r) => r.worker === w));
				view.current = {
					...view.current,
					devices: [...view.current.devices, ...added].sort((a, b) => a.worker - b.worker),
					...(runners
						? {
								runners: [...runners, ...fresh.map((worker) => ({ worker, specs: [] }))].sort(
									(a, b) => a.worker - b.worker
								),
							}
						: {}),
				};
				frame(false);
			},
		};
	}

	/** The specs of the shard job `job` (`shard-0`, or `shard-0@<leg>`), for the grid row that runs it. */
	private shardSpecIds(specs: readonly TrackedSpec[] | undefined, job: string): string[] {
		return (specs ?? [])
			.filter((f) => f.job !== undefined && (job === f.job || job.startsWith(`${f.job}@`)))
			.map((f) => f.id);
	}

	/**
	 * Run every pool's queue behind the grid, each as soon as its pool is ready; `ready` are the queues
	 * ready when the grid starts (its first rows), the others add their rows as they come. A run with
	 * `specs` also ticks them off live from the jobs' `results.jsonl`.
	 */
	private async runGrid(
		ctx: CommandContext,
		deps: BatchDeps,
		args: BatchArgs,
		r: RunContext,
		pending: readonly Promise<Queue>[],
		o: {
			ready: readonly Queue[];
			total: number;
			startedAt: number;
			resultFiles: ResultFiles;
			specs: readonly TrackedSpec[] | undefined;
			/** an elastic worker is about to join: its device (put in the grid), or undefined */
			onJoin?: (worker: number) => Device | undefined;
			onStart?: (queue: Queue, handle: BatchHandle) => void;
		}
	): Promise<{ summary: BatchSummary; screen: Display }> {
		const rows = o.ready.flatMap((q) => q.rows).sort((a, b) => a.worker - b.worker);
		const { specs } = o;
		const sized = this.startView(r.devices, o.total, o.startedAt, specs);
		const screen = this.display(
			ctx,
			deps,
			args,
			{ current: this.startView(rows, o.total, o.startedAt, specs) },
			specs,
			sized
		);
		const ended = new Set<string>();
		const poller = specs ? specPollerHelpers.specPoller(deps, specs, o.resultFiles, ended, screen) : undefined;
		const shown = new Set(o.ready);
		try {
			const summary = await this.runPools(pending, {
				retry: args.retry,
				now: ctx.now,
				signal: r.signal,
				...(o.onStart ? { onStart: o.onStart } : {}),
				onEvent: (e) => {
					if (e.type === "job-end") ended.add(this.attemptKey(e));
					if (e.type === "worker-join") {
						const joined = o.onJoin?.(e.worker);
						if (joined) screen.rows([joined]);
					}
					screen.event(e);
				},
				onQueue: (queue) => {
					if (!shown.has(queue) && queue.rows.length > 0) screen.rows(queue.rows);
				},
			});
			poller?.stop();
			await poller?.poll();
			if (specs) await this.readRunnerReport(deps, o.resultFiles, specs, o.startedAt, screen);
			return { summary, screen };
		} catch (error) {
			// the grid owns the terminal: give it back before the error is reported (R4)
			screen.end();
			throw error;
		} finally {
			poller?.stop();
		}
	}

	/** Hand every job's finished `results.jsonl` to the display as one report (the last attempt of a spec wins); missing files and stale results are skipped. */
	private async readRunnerReport(
		deps: BatchDeps,
		resultFiles: ResultFiles,
		specs: readonly TrackedSpec[],
		since: number,
		screen: Display
	): Promise<void> {
		const texts = await Promise.all([...resultFiles.values()].map((path) => deps.readFile(path).catch(() => "")));
		const report = runnerReportHelpers.resultsReport(texts, specs, since);
		if (report) screen.report(report);
	}

	/** The grid's first frame: with sharded specs, one (empty) runner per worker that takes its shard's specs when the shard starts. */
	private startView(
		rows: ReadonlyArray<{ worker: number; udid: string; name: string }>,
		total: number,
		startedAt: number,
		specs: readonly TrackedSpec[] | undefined
	): BatchView {
		const view = tuiHelpers.initialView(rows, total, startedAt);
		return specs?.some((f) => f.job !== undefined) ? tuiHelpers.withRunners(view, []) : view;
	}

	private tick(mark: SpecMark) {
		return mark === "passed" ? "✓" : "✗";
	}

	/** `--no-tui`: one line per spec the first time it is marked (or its mark changes), named by the worker's pool. */
	private announceSpecs(
		ctx: CommandContext,
		view: BatchView,
		worker: number,
		marks: Readonly<Record<string, SpecMark>>
	): void {
		const [first, ...rest] = view.devices.filter((d) => d.worker === worker);
		const name = `${first?.name ?? "?"}${rest.length > 0 ? ` +${rest.length}` : ""}`;
		for (const f of view.runners?.find((r) => r.worker === worker)?.specs ?? []) {
			const mark = marks[f.id];
			if (mark && mark !== f.mark) ctx.err(`${name} ${this.tick(mark)} ${f.id}`);
		}
	}

	/** `--no-tui`: after the runner's report, one line per device with the specs it ran. */
	private announceDevices(ctx: CommandContext, view: BatchView): void {
		for (const d of view.devices)
			if (d.ran && d.ran.length > 0)
				ctx.err(`${d.name}: ${d.ran.map((f) => `${this.tick(f.mark)} ${f.id}`).join("  ")}`);
	}

	/**
	 * Start one recording per device (in parallel); failures stop the ones that started. A `lost` device
	 * (shut down by the headless hide and not booted again) gets none: there is nothing to record (S2).
	 */
	async startRecordings(
		deps: BatchDeps,
		dir: string,
		all: Device[],
		lost: readonly string[] = []
	): AsyncResult<Recording[]> {
		const devices = all.filter((d) => !lost.includes(d.udid));
		const started = await Promise.allSettled(
			devices.map((d) => deps.record(d.udid, join(dir, batchRecord.videoName(d.worker))))
		);
		const recordings = started.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
		const failed = started.find((s) => s.status === "rejected");
		if (failed) {
			await Promise.all(recordings.map((r) => r.stop()));
			return resultFactory.err(
				`--record: ${failed.reason instanceof Error ? failed.reason.message : String(failed.reason)}`
			);
		}
		devices.forEach((d, i) => {
			d.video = batchRecord.videoName(d.worker);
			d.videoStartedAt = recordings[i]?.startedAt;
		});
		return resultFactory.ok(recordings);
	}

	/** Add `proc`'s log drain wait (when it reports one) to the attempt's total in `drains`. */
	private addDrain(drains: Map<string, number> | undefined, key: string, proc: ProcHandle): void {
		const drained = proc.logDrainMs?.();
		if (drained !== undefined && drains) drains.set(key, (drains.get(key) ?? 0) + drained);
	}

	/** Arm the job timeout: `onExpire` (the screenshot) runs first, then SIGTERM, then SIGKILL after the grace period. */
	private watchdog(deps: BatchDeps, timeoutMs: number | undefined, proc: ProcHandle, onExpire: () => Promise<void>) {
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
	private deviceNameEnv(name: string | undefined): Record<string, string> {
		return name === undefined ? {} : { [ENV_NAMES.deviceName]: name };
	}

	/**
	 * The socket env for a job on a device whose helper is warm: `WARDEN_SIMD_SOCKET` (a simulator's `warden-simd`), or
	 * `WARDEN_IOS_RUNNER_SOCKET` for a physical iPhone's runner host.
	 */
	socketEnv(udid: string, socketPath: string | undefined): Record<string, string> {
		if (socketPath === undefined) return {};
		return { [leaseModel.isPhysicalIosId(udid) ? ENV_NAMES.iosRunnerSocket : ENV_NAMES.simdSocket]: socketPath };
	}

	/** `WARDEN_DEVICE_KIND=physical` for a job on a real phone (a mixed run's other jobs get none: `childEnv` leaves it out). */
	private deviceKindEnv(physical: boolean): Record<string, string> {
		return physical ? { [ENV_NAMES.deviceKind]: "physical" } : {};
	}

	/** `WARDEN_LEASE_ID`: the lease a job's device is held under, so a spec can record its conditions on it. */
	private leaseIdEnv(leaseId: string | undefined): Record<string, string> {
		return leaseId === undefined ? {} : { [ENV_NAMES.leaseId]: leaseId };
	}

	/**
	 * The per-job `run` for `runBatch`: expand the argv, spawn with the job env + log, track it for
	 * SIGINT. With `passes` > 1 the job is spawned again after each green run (`WARDEN_PASS`, one log
	 * per pass); the first red run is the attempt's exit code. A job past `jobTimeoutMs` is shot,
	 * then killed, and its attempt exits `TIMEOUT_EXIT`.
	 */
	readonly jobRunner = (deps: BatchDeps, o: JobRunnerOptions) => {
		const { leg } = o.pool;
		const baseJob = (id: string) => (o.qualified && leg !== undefined ? id.slice(0, -(leg.length + 1)) : id);
		/** the device of a failed attempt, next to its log (`….log` → `….png`); never throws */
		const shoot = async (w: BatchWorker, seq: number, log: string): Promise<void> => {
			const key = this.attemptKey({ worker: w.worker, seq });
			const path = log.replace(/\.log$/, ".png");
			try {
				if ((await deps.screenshot(o.platform, w.udid, path)) && !o.screenshots.has(key)) o.screenshots.set(key, path);
			} catch {
				// best effort
			}
		};
		/**
		 * Whether the attempt's spec runner already shot the device at its failed test (`failure.png` in
		 * `results.jsonl`): then a batch shot, taken after the whole process ran on, is skipped. Never throws.
		 */
		const runnerShot = async (out: string | undefined): Promise<boolean> => {
			if (!out) return false;
			try {
				const { resultsFiles } = await import("@delacour/warden-e2e/runner/results");
				return (
					screenshotHelpers.runnerFailureShot(resultsFiles.read(await deps.readFile(join(out, "results.jsonl")))) !==
					undefined
				);
			} catch {
				return false;
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
				pass,
				udid: w.udid,
				batchDir: o.batchDir,
				metroUrl: o.vars.metroUrl,
			};
			const env: Record<string, string | undefined> = {
				...o.env,
				...o.hooks.jobEnv?.(input),
				...this.socketEnv(w.udid, await o.socketFor(w.udid)),
				...this.deviceKindEnv(o.live.find((d) => d.udid === w.udid)?.physical === true),
				WARDEN_UDID: w.udid,
				...this.deviceNameEnv(o.live.find((d) => d.udid === w.udid)?.name),
				...this.leaseIdEnv(o.live.find((d) => d.udid === w.udid)?.leaseId),
				WARDEN_WORKER: String(w.worker),
				WARDEN_JOB: job,
				WARDEN_JOB_SEQ: String(seq),
				WARDEN_PASS: String(pass),
			};
			const suffix = o.passes > 1 ? `.pass${pass}` : "";
			const log = join(o.logDir, `${w.worker}-${seq}-${batchJobs.slug(id)}${suffix}.log`);
			const vars = {
				job,
				udid: w.udid,
				worker: w.worker,
				seq,
				...o.vars,
				...(leg !== undefined ? { leg } : {}),
			};
			const argv = batchJobs.expandArgv(o.hooks.argvFor ? await o.hooks.argvFor(job, input) : o.cmd, vars);
			return { job, env, log, argv };
		};
		const spawnOnce = async (
			w: BatchWorker,
			id: string,
			seq: number,
			attempt: number,
			pass: number
		): Promise<number> => {
			const { job, env, log, argv } = await plan(w, id, seq, attempt, pass);
			// a spawn that waited for its device's warm-up through a SIGINT does not start
			if (o.interrupted()) return 130;
			o.logs.set(this.attemptKey({ worker: w.worker, seq }), log);
			const out = env[ENV_NAMES.out];
			if (out) o.resultFiles.set(this.attemptKey({ worker: w.worker, seq }), join(out, "results.jsonl"));
			let proc: ProcHandle;
			try {
				const group = o.jobTimeoutMs !== undefined ? { group: true } : {};
				proc = deps.spawn(argv, { env, log, cwd: o.cwd, job: true, ...group });
			} catch {
				return 127;
			}
			o.running.add(proc);
			const timer = this.watchdog(deps, o.jobTimeoutMs, proc, async () => {
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
			this.addDrain(o.drains, this.attemptKey({ worker: w.worker, seq }), proc);
			if (timer.expired()) return TIMEOUT_EXIT;
			if (code !== 0 && !o.interrupted() && !(await runnerShot(out))) await shoot(w, seq, log);
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
	};

	/** Write `batch.json` (+ `tui.cast`), print `--json` / the closing lines. */
	private async report(ctx: CommandContext, deps: BatchDeps, args: BatchArgs, r: BatchRun): Promise<void> {
		const headless = args.flags.headless === true;
		const doc = this.summaryJson(
			r.batchId,
			r.cmd,
			r.startedAt,
			r.endedAt,
			r.devices,
			r.summary,
			r.screenshots,
			headless,
			r.drains
		);
		await deps.writeFile(join(r.batchDir, "batch.json"), `${JSON.stringify(doc, null, 2)}\n`);
		if (r.cast) await deps.writeFile(join(r.batchDir, "tui.cast"), r.cast.text());
		if (args.json) output.emit(ctx, true, doc, "");
		output.note(ctx, `warden batch: logs in ${r.logDir}${args.record ? `, recording in ${args.record}` : ""}`);
		if (args.tui && deps.terminal.isTTY) {
			const passed = r.summary.results.filter((j) => j.exitCode === 0).length;
			ctx.err(`warden batch: ${passed}/${r.total} passed, ${r.summary.failed.length} failed`);
		}
	}

	/** `hooks.shutdownIf`: stop the session's devices while their leases are still held; failures only warn. */
	private async shutdownDevices(
		ctx: CommandContext,
		hooks: SessionHooks & { name: string },
		session: LeaseSession,
		summary: BatchSummary
	): Promise<void> {
		if (!hooks.shutdownIf?.(summary)) return;
		const store = ctx.store();
		const leases = session.leaseIds.flatMap((id) => store.getLease(id) ?? []);
		const owner = ownerResolver.resolve(ctx);
		const { notes } = await spinnerContext.withSpinner(ctx, "shutting down devices…", async (sctx, spinner) => {
			const outcome = await new ReleasedDeviceShutdown(leaseHostBuilder.leaseHostFromContext(sctx)).run(leases, owner);
			spinner.succeed(outcome.shutdown.length > 0 ? `shut down ${outcome.shutdown.join(" ")}` : "nothing to shut down");
			return outcome;
		});
		for (const line of notes) output.note(ctx, `warden ${hooks.name}: ${line}`);
	}

	/** Per-device setup (`hooks.setup`) of one pool: who is left to run jobs and every outcome. */
	private async prepareDevices(
		ctx: CommandContext,
		deps: BatchDeps,
		name: string,
		spec: DeviceSetupSpec | undefined,
		platform: Platform,
		devices: Device[],
		env: Record<string, string | undefined>,
		cwd: string,
		logDir: string,
		running: Set<ProcHandle>,
		slim: (udid: string, profile?: SlimProfile) => AsyncResult<string[]>
	): Promise<{ live: Device[]; setups?: DeviceSetup[] }> {
		if (!spec) return { live: devices };
		const setups = await batchSetup.setupDevices({
			devices,
			spec,
			env,
			cwd,
			logDir,
			spawn: (argv, o) => deps.spawn(argv, o),
			// a simulator op, so never off iOS
			...(platform === "ios" ? { slim } : {}),
			track: (proc) => {
				const handle = proc as ProcHandle;
				running.add(handle);
				return () => running.delete(handle);
			},
		});
		for (const d of setups) {
			if (d.slim && "error" in d.slim) output.warn(ctx, `warden ${name}: slim ${d.udid}: ${d.slim.error}`);
			if (!d.ok) output.reportError(ctx, name, `setup failed on ${d.udid} (exit ${d.exitCode}) — log: ${d.log}`);
		}
		return { live: devices.filter((d) => setups.find((s) => s.worker === d.worker)?.ok), setups };
	}

	/** `deps.slim`, recorded so a later plain `warden claim` knows to restore the device; `fixed` is the suite's profile, used unless the caller passes one. */
	private recordedSlim(ctx: CommandContext, deps: BatchDeps, fixed?: SlimProfile) {
		return async (udid: string, profile?: SlimProfile): AsyncResult<string[]> => {
			// a physical iPhone has no simulator daemons to switch off
			if (leaseModel.isPhysicalIosId(udid)) return resultFactory.ok([]);
			const res = await deps.slim(udid, profile ?? fixed);
			if (res.success) ctx.store().setSlimmed("ios", udid, ctx.now());
			return res;
		};
	}

	/**
	 * A device the store records as slimmed keeps its daemons off (the disable persists across its reboots),
	 * so its slim is not even probed (12-4). That includes one this claim booted: the provider slims what it
	 * boots (offline before the first boot, else live once ready) and records it, so the early slim only
	 * handles what the provider could not.
	 */
	private alreadySlimmed(ctx: CommandContext, claimed: ClaimedDevice): boolean {
		return ctx
			.store()
			.listDevices("ios")
			.some((d) => d.id === claimed.device.id && d.slimmedAt !== undefined);
	}

	/** 130 when the run was interrupted, else 0 for a clean pass and 1 for any failure. */
	private exitFor(interrupted: boolean, passed: boolean): number {
		return interrupted ? 130 : passed ? 0 : 1;
	}

	/** One pool per claim: the legs' devices in claim order, `worker` counted across all of them. */
	private buildPools(session: LeaseSession, args: BatchArgs): Pool[] {
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
					...(leaseModel.isPhysicalDevice(c.device) ? { physical: true as const } : {}),
					leaseId: c.lease.id,
					...(leg ? { leg: leg.name } : {}),
				})),
			};
		});
	}

	/**
	 * A pool's env: the run env with `WARDEN_UDIDS` / `WARDEN_UDID_<i>` narrowed to the pool's own
	 * devices (a leg's runner must not see another leg's), then the leg's env and `WARDEN_LEG`.
	 */
	private poolEnv(
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

	/**
	 * Start the run's Metro on its leased port and prewarm the bundle without waiting for either: the
	 * device claim (sims booting) and the app installs go on meanwhile, `awaitRunMetro` collects the
	 * result. The server is called ready only once the port is verified to serve this project root.
	 */
	private launchRunMetro(
		ctx: CommandContext,
		deps: BatchDeps,
		plan: MetroPlan,
		o: {
			port: number;
			env: Record<string, string | undefined>;
			log: string;
			platform: Platform;
			interrupted: () => boolean;
			/** the run's SIGINT / SIGTERM: ends the prewarm at once */
			signal?: AbortSignal;
		}
	): MetroLaunch {
		let cancelled = false;
		const controller = new AbortController();
		const prewarmSignal = o.signal ? AbortSignal.any([controller.signal, o.signal]) : controller.signal;
		let announced = false;
		const launch: MetroLaunch = {
			port: o.port,
			platform: o.platform,
			log: o.log,
			state: "starting",
			started: undefined,
			pending: Promise.resolve(resultFactory.err("Metro not started")),
			stop: async () => {
				cancelled = true;
				// the prewarm ends at once (12-5); a server already up is killed without waiting for it
				controller.abort();
				if (launch.started === undefined) await launch.pending;
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
			const started = await new MetroRunner({
				probe: deps.metroProbe,
				now: ctx.now,
				sleep: deps.sleep,
				spawn: (cmd, env, cwd) => deps.spawn(cmd, { env, log: o.log, cwd, group: true, metro: true }),
				expoBin: (root) => metroTools.expoBin(root, deps.which),
				git: (root) => gitFactsReader.readSync(root, { cache: ctx.git }),
			}).start({
				projectRoot: plan.projectRoot,
				port: o.port,
				// CI: no interactive prompts (a busy port fails instead of asking) and no file watching
				env: { ...o.env, ...plan.env, CI: "1" },
				readyTimeoutMs: plan.readyTimeoutMs,
				aborted: () => cancelled || o.interrupted(),
			});
			if (!started.success) return started;
			launch.started = started.data;
			if (plan.prewarm) {
				launch.state = "bundling";
				const warmed = await deps.prewarm(started.data.url, o.platform, prewarmSignal);
				if (!warmed.success) return warmed;
			}
			return started;
		};
		launch.pending = run()
			.catch((error: unknown) => resultFactory.err(error instanceof Error ? error.message : String(error)))
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
	private async awaitRunMetro(ctx: CommandContext, launch: MetroLaunch): AsyncResult<Metro> {
		const settled = launch.state === "up" || launch.state === "failed";
		const metro = settled
			? await launch.pending
			: await spinnerContext.withSpinner(ctx, `starting Metro on :${launch.port}…`, async (_sctx, spinner) => {
					if (launch.state === "bundling")
						spinner.update(`Metro on :${launch.port}: building the ${launch.platform} bundle…`);
					const result = await launch.pending;
					if (!result.success) spinner.fail("Metro not ready");
					return result;
				});
		if (!metro.success) return resultFactory.err(`${metro.error} (log: ${launch.log})`);
		launch.announce(ctx.err);
		return metro;
	}

	/**
	 * Point every device at the run's Metro before its first job: Android gets the port reversed; iOS
	 * relaunches the app with `--initialUrl` when its bundle id is known, for at most `OPEN_LAUNCH_MS`.
	 * A failed iOS launch only warns — the runner opens the app itself. An Android device whose port
	 * cannot be reversed (after one retry) cannot reach Metro at all: it is returned, to be dropped (12-7).
	 */
	async openOnDevices(
		ctx: CommandContext,
		name: string,
		platform: Platform,
		plan: MetroPlan,
		metro: Pick<Metro, "port" | "url">,
		devices: ReadonlyArray<{ udid: string }>
	): Promise<Array<{ udid: string; error: string }>> {
		const unreachable = await Promise.all(
			devices.map(async (d): Promise<{ udid: string; error: string } | undefined> => {
				if (platform === "android") {
					const reversed = await metroTools.reversePort(ctx.exec, d.udid, metro.port);
					return reversed.success ? undefined : { udid: d.udid, error: reversed.error };
				}
				if (plan.bundleId === undefined) return undefined;
				const argv = metroTools.devClientLaunchArgv(d.udid, plan.bundleId, metro.url, plan.launchArgs);
				const res = await ctx.exec(argv, { timeoutMs: OPEN_LAUNCH_MS });
				if (res.exitCode !== 0) output.warn(ctx, `warden ${name}: ${execErrors.format(argv, res)}`);
				return undefined;
			})
		);
		return unreachable.flatMap((u) => (u ? [u] : []));
	}

	/**
	 * One scheduler per pool, each started the moment its own pool is ready (12-3); their events feed one
	 * grid and their summaries merge. `onQueue` sees each queue as its pool becomes ready.
	 */
	private async runPools(
		pending: readonly Promise<Queue>[],
		o: {
			retry: number;
			now: () => number;
			signal: AbortSignal;
			onEvent: (e: BatchEvent) => void;
			onQueue: (queue: Queue) => void;
			/** a pool's scheduler is running: workers may join it through `handle` */
			onStart?: (queue: Queue, handle: BatchHandle) => void;
		}
	): Promise<BatchSummary> {
		const pools: Queue[] = [];
		const summaries = await Promise.all(
			pending.map(async (queued) => {
				const pool = await queued;
				pools.push(pool);
				o.onQueue(pool);
				return batchScheduler.run({
					workers: pool.workers,
					jobs: pool.jobs,
					retry: o.retry,
					now: o.now,
					signal: o.signal,
					...(o.onStart ? { onStart: (handle: BatchHandle) => o.onStart?.(pool, handle) } : {}),
					// each pool reports its own `done`; the run has one
					onEvent: (e) => {
						if (e.type !== "done") o.onEvent(e);
					},
					run: pool.run,
				});
			})
		);
		const stopped = summaries.some((s) => s.stopped);
		// a pool with no device left ran nothing: that is not a pass
		const ok = summaries.every((s) => s.ok) && pools.every((p) => p.workers.length > 0 || p.jobs.length === 0);
		o.onEvent({ type: "done", ok, stopped, at: o.now() });
		return { ok, stopped, results: summaries.flatMap((s) => s.results), failed: summaries.flatMap((s) => s.failed) };
	}

	/**
	 * Each device's socket for its jobs, asked by every spawn and looked up once (12-3): with the early
	 * warm-up, that device's own warm-up (its warning printed then, through `say`); without one, the
	 * socket of a helper already running for it (iOS). Never rejects.
	 */
	private deviceSockets(
		ctx: CommandContext,
		r: RunContext,
		warm: EarlyWarm | undefined,
		resident: ((udid: string) => Promise<string | undefined>) | undefined,
		say: (line: string) => void
	): (udid: string) => Promise<string | undefined> {
		const memo = new Map<string, Promise<string | undefined>>();
		const lookup = async (udid: string): Promise<string | undefined> => {
			if (warm) {
				const done = await warm.device(udid);
				if (done.warning !== undefined) say(ctx.ui.color.yellow(`warden ${r.name}: ${done.warning}`));
				return done.socketPath;
			}
			if (resident && r.platform === "ios") return resident(udid).catch(() => undefined);
			return undefined;
		};
		return (udid) => {
			const known = memo.get(udid);
			if (known) return known;
			const looked = lookup(udid);
			memo.set(udid, looked);
			return looked;
		};
	}

	/**
	 * The warm helpers of devices dropped before their jobs are closed: now when the warm-up is done, else
	 * as it lands (`teardown` closes any still open). Never waits for a warm-up still under way.
	 */
	private async closeDropped(warm: EarlyWarm, dropped: readonly Device[], closed: Set<WarmHelper>): Promise<void> {
		const close = async (helper: WarmHelper | undefined) => {
			if (!helper || closed.has(helper)) return;
			closed.add(helper);
			await helper.close().catch(() => {});
		};
		await Promise.all(
			dropped.map((d) => {
				const now = warm.peek(d.udid);
				if (now) return close(now.helper);
				void warm.device(d.udid).then((later) => close(later.helper));
				return undefined;
			})
		);
	}

	/** Metro (started during the claim) → serve → recordings; resolves the job env + placeholder values once they are up. */
	private async startServices(
		ctx: CommandContext,
		deps: BatchDeps,
		args: BatchArgs,
		r: RunContext,
		baseEnv: Record<string, string | undefined>,
		services: Services,
		metro: MetroLaunch | undefined
	): AsyncResult<{ env: Record<string, string | undefined>; vars: RunVars }> {
		if (args.metro) {
			if (!metro) return resultFactory.err("metro: no port leased for it");
			const up = await this.awaitRunMetro(ctx, metro);
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
			const up = await this.startServe(ctx, deps, args.serve, { r, env, vars, cwd: args.cwd, services });
			if (!up.success) return up;
		}
		if (args.record) {
			const started = await this.startRecordings(deps, args.record, r.devices, r.lost);
			if (!started.success) return started;
			services.recordings = started.data;
		}
		return resultFactory.ok({ env, vars });
	}

	/** Start serve (`{port}` / `{metroUrl}` substituted) and wait until it is ready. */
	private async startServe(
		ctx: CommandContext,
		deps: BatchDeps,
		serve: Serve,
		o: { r: RunContext; env: Record<string, string | undefined>; vars: RunVars; cwd: string; services: Services }
	): AsyncResult<void> {
		const log = join(o.r.logDir, "serve.log");
		const ready = serve.ready
			? batchServe.parseReadySpec(batchJobs.expand(serve.ready.spec, o.vars), serve.ready.cwd)
			: resultFactory.ok(undefined);
		if (!ready.success) return ready;
		const proc = deps.spawn(["sh", "-c", batchJobs.expand(serve.cmd, o.vars)], {
			env: o.env,
			log,
			group: true,
			cwd: o.cwd,
		});
		o.services.serve = proc;
		const up = await this.waitReady(ctx, deps, serve, ready.data, proc, o.r.interrupted);
		return up.success ? up : resultFactory.err(`${up.error} (log: ${log})`);
	}

	/** A resident `warden ui` host would fight the jobs' own drivers for an emulator's one `warden-uiad` slot: stop it. */
	private async stopResidentHosts(ctx: CommandContext, name: string, devices: readonly Device[]): Promise<void> {
		const serials = devices.map((d) => d.udid);
		for (const warning of await uiHelperSweep.stopAndroidHostsLazily(ctx, serials))
			output.warn(ctx, `warden ${name}: ${warning}`);
	}

	/**
	 * One pool from its claim to its first job, on its own devices only (12-3): setup (slim, then the
	 * command), then Metro's open beside the late-window hide. A device whose setup fails, or that cannot
	 * reach Metro (Android, 12-7), is dropped, and its warm helper closed.
	 */
	private readonly preparePool = async (
		ctx: CommandContext,
		deps: BatchDeps,
		args: BatchArgs,
		r: RunContext,
		session: LeaseSession,
		pool: Pool,
		o: {
			env: Record<string, string | undefined>;
			metro: { plan: MetroPlan; up: Metro } | undefined;
			slim: (udid: string, profile?: SlimProfile) => AsyncResult<string[]>;
			warm: EarlyWarm | undefined;
			closed: Set<WarmHelper>;
		}
	): Promise<PreparedPool> => {
		// a device the claim's headless hide could not boot again is dropped before its setup (R5)
		const lost = new Map((session.lost ?? []).map((udid) => [udid, "did not come back after the headless hide"]));
		const devices = pool.devices.filter((d) => !lost.has(d.udid));
		for (const d of pool.devices)
			if (lost.has(d.udid)) output.reportError(ctx, r.name, `${d.udid} ${lost.get(d.udid)}, dropped`);
		const setupEnv = this.poolEnv(o.env, pool, devices);
		if (r.platform === "android") await this.stopResidentHosts(ctx, r.name, devices);
		const setup = await this.prepareDevices(
			ctx,
			deps,
			r.name,
			r.hooks.setup,
			r.platform,
			devices,
			setupEnv,
			args.cwd,
			r.logDir,
			r.running,
			o.slim
		);
		const [unreachable] = await Promise.all([
			o.metro ? this.openOnDevices(ctx, r.name, r.platform, o.metro.plan, o.metro.up, setup.live) : [],
			this.hideLateWindows(ctx, deps, args, r, session, setup.live),
		]);
		for (const u of unreachable) output.reportError(ctx, r.name, `${u.udid} cannot reach Metro, dropped: ${u.error}`);
		const failed = new Map([...lost, ...unreachable.map((u): [string, string] => [u.udid, u.error])]);
		const live = setup.live.filter((d) => !failed.has(d.udid));
		if (o.warm)
			await this.closeDropped(
				o.warm,
				pool.devices.filter((d) => !live.includes(d)),
				o.closed
			);
		const outcomes = (setup.setups ?? []).map((d) => {
			const error = failed.get(d.udid);
			return error === undefined ? d : { ...d, ok: false, error };
		});
		for (const d of pool.devices) {
			const error = failed.get(d.udid);
			if (error !== undefined && !outcomes.some((o) => o.udid === d.udid))
				outcomes.push({ worker: d.worker, udid: d.udid, ok: false, error });
		}
		return { pool, live, ...(setup.setups || outcomes.length > 0 ? { setups: outcomes } : {}) };
	};

	/** Start every pool's preparation at once; `ready` fills with each pool as it becomes ready. */
	private startPools(
		ctx: CommandContext,
		deps: BatchDeps,
		args: BatchArgs,
		r: RunContext,
		session: LeaseSession,
		prepare: Parameters<typeof this.preparePool>[6]
	): { preparing: Promise<PreparedPool>[]; ready: PreparedPool[] } {
		// a pool whose preparation throws fails on its own (no device left, an error each): the others run on (R4)
		const preparing = r.pools.map((pool) =>
			this.preparePool(ctx, deps, args, r, session, pool, prepare).catch((error: unknown): PreparedPool => {
				const message = error instanceof Error ? error.message : String(error);
				output.reportError(
					ctx,
					r.name,
					`${pool.devices.map((d) => d.udid).join(", ")}: setup failed, dropped: ${message}`
				);
				const setups = pool.devices.map((d) => ({ worker: d.worker, udid: d.udid, ok: false, error: message }));
				return { pool, live: [], setups };
			})
		);
		const ready: PreparedPool[] = [];
		for (const p of preparing)
			void p.then(
				(prepared) => ready.push(prepared),
				() => {}
			);
		return { preparing, ready };
	}

	/** A prepared pool's queue, built once however often it is asked for. */
	private queueMaker(
		ctx: CommandContext,
		deps: BatchDeps,
		args: BatchArgs,
		r: RunContext,
		o: Parameters<typeof this.poolQueue>[5]
	): (prepared: PreparedPool) => Queue {
		const queueOf = new Map<PreparedPool, Queue>();
		return (prepared) => {
			const known = queueOf.get(prepared);
			if (known) return known;
			const queue = this.poolQueue(ctx, deps, args, r, prepared, o);
			queueOf.set(prepared, queue);
			return queue;
		};
	}

	/** Every pool's device outcomes: undefined when the run had no setup and dropped no device. */
	private setupsOf(r: RunContext, prepared: readonly PreparedPool[]): DeviceSetup[] | undefined {
		const all = prepared.flatMap((p) => p.setups ?? []);
		return r.hooks.setup || all.length > 0 ? all : undefined;
	}

	/** Resolves true once any pool has a device left to run jobs, false once every pool is done without one. */
	private firstLive(pending: readonly Promise<PreparedPool>[]): Promise<boolean> {
		return new Promise((resolve) => {
			let left = pending.length;
			if (left === 0) resolve(false);
			for (const p of pending) {
				p.then(
					(prepared) => {
						if (prepared.live.length > 0) resolve(true);
					},
					() => {}
				).finally(() => {
					if (--left === 0) resolve(false);
				});
			}
		});
	}

	/** A pool's job queue: its workers (one per device that survived setup) and its job runner. */
	private readonly poolQueue = (
		ctx: CommandContext,
		deps: BatchDeps,
		args: BatchArgs,
		r: RunContext,
		p: PreparedPool,
		o: {
			jobs: string[];
			cmd: string[];
			env: Record<string, string | undefined>;
			vars: RunVars;
			screenshots: Map<string, string>;
			logs: Map<string, string>;
			resultFiles: Map<string, string>;
			socketFor: (udid: string) => Promise<string | undefined>;
			drains?: Map<string, number>;
		}
	): Queue => {
		const qualified = r.pools.length > 1;
		const onTimeout = (job: string, w: BatchWorker) => {
			const after = durationParser.format(args.jobTimeoutMs ?? 0);
			output.reportError(ctx, r.name, `${job} still running on ${w.udid} after ${after} — killing it`);
		};
		return {
			workers: p.live,
			rows: p.live,
			jobs: o.jobs.map((job) => this.legJob(job, qualified ? p.pool.leg : undefined)),
			run: this.jobRunner(deps, {
				cmd: o.cmd,
				env: this.poolEnv(o.env, p.pool, p.live),
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
				socketFor: o.socketFor,
				...(o.drains ? { drains: o.drains } : {}),
				running: r.running,
				interrupted: r.interrupted,
				hooks: r.hooks,
			}),
		};
	};

	/** The run env before Metro is up: lease env + preset / suite env + `WARDEN_BATCH_DIR` / `WARDEN_PORT`. */
	private runEnv(session: LeaseSession, args: BatchArgs, batchDir: string): Record<string, string | undefined> {
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
	private async hideLateWindows(
		ctx: CommandContext,
		deps: BatchDeps,
		args: BatchArgs,
		r: RunContext,
		session: LeaseSession,
		live: readonly Device[]
	): Promise<void> {
		if (r.platform !== "ios" || !args.flags.headless || claimRequestRules.bootedByClaim(session.outcome).length === 0)
			return;
		const warn = (line: string) => ctx.err(ctx.ui.color.yellow(`warden ${r.name}: ${line}`));
		// arbitrated with every other warden hide (16-8); a device the close shut down loses its resident helper
		await new SimWindowHider({
			exec: ctx.exec,
			sleep: deps.sleep,
			warn,
			detachLock: claimRequestRules.detachLockFor(contextBuilder.appHostFromContext(ctx)),
			onShutDown: uiStopHelperAfter.stopHelperAfter(ctx),
		}).hide(live);
	}

	/**
	 * An elastic worker: claim one more device at the late priority (installing the app, warming and
	 * slimming it as it is leased), prepare it like a pool of one, and hand it back for `addWorker`. A device
	 * that is lost to the headless hide or fails its setup is released.
	 */
	private async claimLateWorker(
		ctx: CommandContext,
		deps: BatchDeps,
		args: BatchArgs,
		r: RunContext,
		session: LeaseSession,
		run: RunSetup,
		prepare: Parameters<typeof this.preparePool>[6],
		o: { worker: number; leg: number; abort: () => boolean; flags: ClaimFlags } & LateSink
	): AsyncResult<LateWorker> {
		const more = await session.claimMore({
			flags: o.flags,
			leg: o.leg,
			aborted: o.abort,
			onLeased: (outcome, at) => {
				run.warm?.leased(outcome, at);
				run.slim?.leased(outcome);
			},
		});
		if (!more.success) return resultFactory.err(more.error.message);
		const { drop, lost, outcome } = more.data;
		const c = outcome.claimed[0];
		const pool = r.pools[0];
		if (!c || !pool || lost.length > 0) {
			await drop();
			return resultFactory.err(`${c?.device.id ?? "device"} did not come back after the headless hide`);
		}
		const device: Device = { worker: o.worker, udid: c.device.id, name: c.device.name, leaseId: c.lease.id };
		const prepared = await this.preparePool(
			ctx,
			deps,
			args,
			r,
			{ ...session, outcome, lost },
			{ ...pool, devices: [device] },
			prepare
		);
		o.prepared.push(prepared);
		if (prepared.live.length === 0) {
			await drop();
			return resultFactory.err(`setup failed on ${device.udid}`);
		}
		o.devices.set(o.worker, device);
		return resultFactory.ok({ worker: { worker: o.worker, udid: device.udid }, drop });
	}

	private elasticRun(
		ctx: CommandContext,
		deps: BatchDeps,
		args: BatchArgs,
		r: RunContext,
		session: LeaseSession,
		run: RunSetup,
		prepare: Parameters<typeof this.preparePool>[6],
		startedAt: number
	): ElasticRun {
		const plan = run.elastic;
		const sink: LateSink = { prepared: [], devices: new Map() };
		let claims: Promise<unknown> = Promise.resolve();
		let queue: Queue | undefined;
		return {
			prepared: sink.prepared,
			settled: () => claims,
			start: (q, handle) => {
				queue = q;
				if (!plan) return;
				claims = lateWorkerClaimer.claim({
					count: plan.plan.extra,
					firstWorker: plan.plan.first,
					handle,
					signal: r.signal,
					log: (line) => output.warn(ctx, `warden ${r.name}: ${line}`),
					claim: (o) =>
						this.claimLateWorker(ctx, deps, args, r, session, run, prepare, { ...o, flags: plan.flags, ...sink }),
				});
			},
			join: (worker) => {
				const device = sink.devices.get(worker);
				if (!device) return undefined;
				device.joinedAfterMs = Math.max(0, ctx.now() - startedAt);
				queue?.workers.push(device);
				r.devices.push(device);
				return device;
			},
		};
	}

	/** What every pool's preparation shares: the run env, Metro once it is up, the slim and the warm-up. */
	private prepareOptions(
		ctx: CommandContext,
		deps: BatchDeps,
		args: BatchArgs,
		run: RunSetup,
		services: Services,
		env: Record<string, string | undefined>
	): Parameters<typeof this.preparePool>[6] {
		const metroPlan = args.metro;
		const metroUp = services.metro;
		return {
			env,
			metro: metroPlan && metroUp ? { plan: metroPlan, up: metroUp } : undefined,
			slim: run.slim?.slim ?? this.recordedSlim(ctx, deps),
			warm: run.warm,
			closed: services.closed,
		};
	}

	/** Everything after the claim: Metro → serve → recordings → setup → jobs → stop serve / recordings / Metro → batch.json → release. */
	private async supervise(
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
		const pools = this.buildPools(session, args);
		const r: RunContext = {
			name: hooks.name,
			batchDir,
			logDir,
			platform: args.flags.request.platform,
			port: session.ports[0]?.port,
			pools,
			devices: pools.flatMap((p) => p.devices),
			lost: session.lost ?? [],
			hooks,
			running: new Set<ProcHandle>(),
			interrupted: () => controller.signal.aborted,
			signal: controller.signal,
		};
		const screenshots = new Map<string, string>();
		const logs = new Map<string, string>();
		const resultFiles = new Map<string, string>();
		const drains = new Map<string, number>();
		const stopHold = new LeaseHeartbeat(contextBuilder.appHostFromContext(ctx), deps).hold(
			session.leaseIds,
			(signal) => {
				controller.abort();
				for (const job of r.running) job.kill(signal);
			}
		);
		const services: Services = { recordings: [], warm: run.warm, closed: new Set() };
		/** elastic workers: the background claims (awaited before the release) and what they prepared */
		let elastic = NO_ELASTIC;
		// a live grid owns the terminal: what a pool still preparing (or a warm-up) says waits until it ends
		const held: string[] = [];
		let holding = false;
		const say = (line: string) => (holding ? held.push(line) : ctx.err(line));
		const flush = () => {
			holding = false;
			for (const line of held.splice(0)) ctx.err(line);
		};
		const pctx: CommandContext = { ...ctx, err: say };
		const fail = (message: string, extra: Partial<SessionResult> = {}): SessionResult => {
			output.reportError(ctx, r.name, message);
			return { code: r.interrupted() ? 130 : 1, ...extra };
		};
		/** workers are done: serve first, then the recordings (the contract's stop order), Metro last */
		const teardown = async () => {
			const { serve, metro, recordings, warm } = services;
			const helpers: WarmHelper[] = [];
			services.serve = undefined;
			services.metro = undefined;
			services.recordings = [];
			services.warm = undefined;
			if (warm) {
				// stop waiting for warm-ups still under way, close every helper that came up (bar those closed already)
				warm.abort();
				helpers.push(...(await warm.settled()).helpers.filter((h) => !services.closed.has(h)));
			}
			if (serve) await this.stopServe(deps, serve);
			await Promise.all(recordings.map((rec) => rec.stop()));
			await Promise.all(helpers.map((helper) => helper.close().catch(() => {})));
			await metro?.stop();
		};
		try {
			await deps.mkdir(logDir);
			const up = await this.startServices(
				ctx,
				deps,
				args,
				r,
				this.runEnv(session, args, batchDir),
				services,
				run.metro
			);
			if (!up.success) return fail(up.error, { batchDir });
			const { env, vars } = up.data;
			const prepare = this.prepareOptions(ctx, deps, args, run, services, env);
			// 12-3: each pool goes from setup to its first job on its own, without waiting for the other legs
			const { preparing, ready } = this.startPools(pctx, deps, args, r, session, prepare);
			if (!(await this.firstLive(preparing))) {
				const setups = this.setupsOf(r, await Promise.all(preparing));
				const failedLogs = (setups ?? []).filter((d) => !d.ok).map((d) => d.log ?? d.error);
				return fail(`setup failed on every device (logs: ${failedLogs.join(", ")})`, { batchDir, setups });
			}
			// a phone's jobs reach its runner only through the warm socket: no runner, no specs
			const phones = run.warm ? r.devices.map((d) => d.udid).filter((id) => leaseModel.isPhysicalIosId(id)) : [];
			const stopped = run.warm && phones.length > 0 ? await warmGateHelpers.warmGate(phones, run.warm) : undefined;
			if (stopped) {
				const failed = fail(`${stopped.udid}: ${stopped.code}: ${stopped.message}`, { batchDir, error: stopped });
				return failed.code === 130 ? failed : { ...failed, code: this.warmStopExit(stopped.code) };
			}
			const socketFor = this.deviceSockets(ctx, r, run.warm, run.warm ? undefined : hooks.residentSocket, say);
			const toQueue = this.queueMaker(ctx, deps, args, r, {
				jobs,
				cmd,
				env,
				vars,
				screenshots,
				logs,
				resultFiles,
				drains,
				socketFor,
			});
			const total = r.pools.length * jobs.length;
			const startedAt = ctx.now();
			holding = args.tui && deps.terminal.isTTY;
			if (run.elastic) elastic = this.elasticRun(pctx, deps, args, r, session, run, prepare, startedAt);
			const { summary, screen } = await this.runGrid(
				ctx,
				deps,
				args,
				r,
				preparing.map((p) => p.then(toQueue)),
				{
					ready: ready.map(toQueue),
					total,
					startedAt,
					resultFiles,
					specs: hooks.specs,
					onStart: elastic.start,
					onJoin: elastic.join,
				}
			);
			await elastic.settled();
			const setups = this.setupsOf(r, [...(await Promise.all(preparing)), ...elastic.prepared]);
			const endedAt = ctx.now();
			screen.end();
			flush();
			await teardown();
			const { devices } = r;
			const done: BatchRun = {
				batchId,
				batchDir,
				logDir,
				cmd,
				devices,
				total,
				startedAt,
				endedAt,
				summary,
				screenshots,
				drains,
			};
			await this.report(ctx, deps, args, screen.cast ? { ...done, cast: screen.cast } : done);
			if (!r.interrupted()) await this.shutdownDevices(ctx, hooks, session, summary);
			return {
				code: this.exitFor(r.interrupted(), summary.ok),
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
			flush();
			// an elastic claim still under way ends (it sees the queue drained or the abort) before its devices go
			await elastic.settled().catch(() => {});
			await teardown();
			// a slim still under way (a run that failed before its setup) ends before its device is released
			await run.slim?.settled();
			stopHold();
			await session.release();
		}
	}

	/** Operands before `--` (at most one: platform or preset) + the command after it (may be empty). */
	private batchOperands(
		argv: readonly string[],
		operands: readonly string[]
	): Result<{ target?: string; cmd: string[] }> {
		const { cmd } = leaseOptions.splitCommand(argv);
		const before = operands.slice(0, Math.max(0, operands.length - cmd.length));
		if (before.length > 1) return resultFactory.err(`unexpected arguments before --: ${before.slice(1).join(" ")}`);
		const [target] = before;
		return resultFactory.ok(target === undefined ? { cmd } : { target, cmd });
	}

	/** `ios` / `android` / nothing (picker) → a platform; anything else is a `batches.<name>` preset. */
	private async resolveTarget(
		ctx: CommandContext,
		target: string | undefined
	): AsyncResult<{ platform: Platform; preset?: BatchPreset }> {
		if (target === undefined || target === "ios" || target === "android") {
			const platform = await claimFlagsHelpers.resolvePlatform(ctx, target);
			return platform.success ? resultFactory.ok({ platform: platform.data }) : platform;
		}
		const stopAt = (await gitFactsReader.read(ctx.exec, ctx.cwd, ctx.git))?.toplevel;
		const found = batchPresets.find({ start: ctx.cwd, env: ctx.env, name: target, ...(stopAt ? { stopAt } : {}) });
		if (!found.success) return found;
		const { preset, names } = found.data;
		if (!preset) {
			const known = names.length > 0 ? `, presets: ${names.join(", ")}` : "";
			return resultFactory.err(`unknown platform or preset "${target}" (ios|android${known})`);
		}
		return resultFactory.ok({ platform: preset.platform, preset });
	}

	/** A preset as option values (paths already absolute, so the invoking cwd doesn't touch them). */
	private presetOpts(preset: BatchPreset): Partial<BatchOpts> {
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
	mergePreset(preset: BatchPreset, opts: BatchOpts, passed: ReadonlySet<string>): { opts: BatchOpts; base: BatchBase } {
		const cli = Object.fromEntries(Object.entries(opts).filter(([key]) => passed.has(key)));
		const cliJobs = passed.has("jobs") || passed.has("jobsFrom");
		return {
			opts: { ...opts, ...this.presetOpts(preset), ...cli },
			base: {
				cwd: preset.cwd,
				...(preset.env ? { env: preset.env } : {}),
				...(preset.jobs && !cliJobs ? { jobs: preset.jobs } : {}),
			},
		};
	}

	private clampFlags(flags: ClaimFlags, jobCount: number): ClaimFlags {
		return jobCount >= flags.request.count
			? flags
			: { ...flags, request: { ...flags.request, count: Math.max(1, jobCount) } };
	}

	/**
	 * More devices than jobs would idle: claim at most one device per job, per leg (same `args` when no
	 * change).
	 */
	clampToJobs(args: BatchArgs, jobCount: number): BatchArgs {
		const flags = this.clampFlags(args.flags, jobCount);
		const legs = args.legs?.map((leg) => ({ ...leg, flags: this.clampFlags(leg.flags, jobCount) }));
		const unchanged = flags === args.flags && (legs ?? []).every((leg, i) => leg.flags === args.legs?.[i]?.flags);
		return unchanged ? args : { ...args, flags, ...(legs ? { legs } : {}) };
	}

	/** Parse → load jobs → claim (under a spinner) → supervise; exit 0 only when every job passed. */
	private async batch(
		ctx: CommandContext,
		deps: BatchDeps,
		operands: readonly string[],
		opts: BatchOpts,
		passed: ReadonlySet<string>
	): Promise<number> {
		const fail = (message: string) => {
			output.reportError(ctx, "batch", message);
			return 1;
		};
		const split = this.batchOperands(ctx.argv, operands);
		if (!split.success) return fail(split.error);
		const target = await this.resolveTarget(ctx, split.data.target);
		if (!target.success) return fail(target.error);
		const { platform, preset } = target.data;
		const cmd = split.data.cmd.length > 0 ? split.data.cmd : (preset?.cmd ?? []);
		if (cmd.length === 0) return fail("missing command after -- (warden batch ios -- <cmd…>)");
		const merged = preset ? this.mergePreset(preset, opts, passed) : { opts, base: {} };
		const explicit = passed.has("headless") ? opts.headless : undefined;
		// a physical device is never headless-hidden: only an explicit --headless reaches the claim (which refuses it)
		const headless = claimFlagsHelpers.isPhysicalClaim(claimFlagsHelpers.withNamedPhysical(merged.opts))
			? explicit
			: headlessResolver.resolve({ flag: explicit, config: preset?.headless, env: ctx.env });
		const args = this.parseBatchArgs(
			platform,
			{
				...merged.opts,
				headless,
				...(preset?.slim !== undefined ? { slimConfig: preset.slim } : {}),
				...(preset?.biometrics === true ? { biometrics: true } : {}),
			},
			ctx.cwd,
			merged.base
		);
		if (!args.success) return fail(args.error);
		const jobs = await this.loadJobs(ctx, deps, args.data);
		if (!jobs.success) return fail(jobs.error);
		// before any lease or build: several usable phones are asked about, or refused (ambiguous_device, exit 2)
		const picked = await physicalPickHelpers.pickPhysicalArgs(ctx, ownerResolver.resolve(ctx), args.data, {
			prompt: physicalPickHelpers.canPrompt(ctx, { json: args.data.json }),
		});
		if (picked.kind !== "ok") return physicalPickHelpers.reportPick(ctx, "batch", picked);
		return (await this.runSession(ctx, deps, picked.args, jobs.data, cmd)).code;
	}

	/** The exit code of a run stopped by a phone's failed warm-up: the `warden ui` code's (a locked phone exits 2), else 1. */
	private warmStopExit(code: string): number {
		return code in UI_ERROR_EXIT ? UI_ERROR_EXIT[code as UiErrorCode] : 1;
	}

	/** A warm-up the run never collected (the claim failed, a signal): stop waiting for it and close what came up. */
	private async closeWarm(warm: EarlyWarm | undefined): Promise<void> {
		if (!warm) return;
		warm.abort();
		const { helpers } = await warm.settled();
		await Promise.all(helpers.map((helper) => helper.close().catch(() => {})));
	}

	/** The early warm-up of an iOS run: each leg's devices are warmed the moment they are leased, overlapping the install and Metro. */
	private startSessionWarm(
		ctx: CommandContext,
		deps: BatchDeps,
		hooks: SessionHooks,
		lease: BatchArgs,
		extra: number,
		logDir: string,
		signal: AbortSignal
	): EarlyWarm | undefined {
		if (!hooks.warmDrivers || lease.flags.request.platform !== "ios") return undefined;
		return earlyWarmHelpers.startEarlyWarm({
			connect: hooks.warmDrivers,
			legCounts: [
				...(lease.legs?.map((leg) => leg.flags) ?? [lease.flags]).map((flags) => flags.request.count),
				...Array<number>(extra).fill(1),
			],
			logDir,
			now: ctx.now,
			after: deps.after,
			writeFile: deps.writeFile,
			signal,
		});
	}

	/** The `onLeased` callback fanning a leased outcome to progress, warm-up and slim; undefined when none is active. */
	private sessionOnLeased(
		progress: ((outcome: ClaimOutcome) => void) | undefined,
		warm: EarlyWarm | undefined,
		slim: EarlySlim<ClaimedDevice> | undefined
	): ((outcome: ClaimOutcome, leg: number) => void) | undefined {
		if (!progress && !warm && !slim) return undefined;
		return (outcome, leg) => {
			progress?.(outcome);
			warm?.leased(outcome, leg);
			slim?.leased(outcome);
		};
	}

	/** The `onPorts` callback launching the run's Metro the moment its port is leased; undefined without a `metro` plan. */
	private sessionOnPorts(
		ctx: CommandContext,
		sctx: CommandContext,
		deps: BatchDeps,
		lease: BatchArgs,
		run: SessionRun,
		batchDir: string,
		controller: AbortController
	): ((ports: RunPort[]) => void) | undefined {
		const plan = lease.metro;
		if (!plan) return undefined;
		const { platform } = lease.flags.request;
		return (ports) => {
			const port = ports[0]?.port;
			if (port === undefined) return;
			const launch = this.launchRunMetro(sctx, deps, plan, {
				port,
				platform,
				log: join(batchDir, "metro.log"),
				env: { ...ctx.env, ...lease.env, WARDEN_BATCH_DIR: batchDir, WARDEN_PORT: String(port) },
				interrupted: () => controller.signal.aborted,
				signal: controller.signal,
			});
			run.launch = launch;
			// up before the claim is done: say so above the claim spinner (the overlap is the point)
			void launch.pending.then((result) => {
				if (result.success && !run.claimDone) launch.announce(sctx.err);
			});
		};
	}

	/** Settle the claim spinner for a finished claim: failed, app ready, or leased. */
	private settleClaimSpinner(
		spinner: Spinner,
		lease: BatchArgs,
		result: Awaited<ReturnType<typeof LeaseSessionRunner.prototype.claimAll>>
	): void {
		if (!result.success) spinner.fail(lease.app ? "claim / app install failed" : "claim failed");
		else if (lease.app) spinner.succeed(`app ready on ${result.data.outcome.claimed.length} device(s)`);
		else spinner.succeed(sessionRules.leasedText(result.data.outcome));
	}

	/** Report and clean up after a claim that failed or was interrupted; returns the exit code. */
	private async abortClaim(
		ctx: CommandContext,
		name: string,
		claimed: Awaited<ReturnType<typeof LeaseSessionRunner.prototype.claimAll>>,
		run: SessionRun,
		interrupted: boolean,
		quiesce: () => Promise<void>
	): Promise<SessionResult> {
		await quiesce();
		if (claimed.success) await claimed.data.release();
		const { launch } = run;
		await launch?.stop();
		const metro = launch ? await launch.pending : undefined;
		const claimError = claimed.success || claimed.error.code === "interrupted" ? undefined : claimed.error.message;
		const metroError = launch && metro && !metro.success ? `${metro.error} (log: ${launch.log})` : undefined;
		const reason = claimError ?? (interrupted ? INTERRUPTED : (metroError ?? INTERRUPTED));
		if (!interrupted && claimError !== undefined && physicalLock.isLockedClaimError(claimError)) {
			return { code: physicalLock.reportClaimFailure(ctx, name, claimError) };
		}
		output.reportError(ctx, name, reason);
		return { code: interrupted ? 130 : 1 };
	}

	/**
	 * Claim (at most one device per job, under a spinner) → supervise → release. With a `metro` plan the
	 * run's Metro is launched the moment its port is leased, so it starts and prewarms while the devices
	 * boot and the app installs; until `supervise` holds the leases, SIGINT / SIGTERM abort the claim and
	 * stop that Metro (a detached process, which the terminal's Ctrl-C would otherwise leave on the port).
	 */
	async runSession(
		ctx: CommandContext,
		deps: BatchDeps,
		args: BatchArgs,
		jobs: string[],
		cmd: string[],
		hooks: SessionHooks = {}
	): Promise<SessionResult> {
		const name = hooks.name ?? "batch";
		const clamped = this.clampToJobs(args, jobs.length);
		if (clamped !== args) output.note(ctx, `warden ${name}: ${jobs.length} job(s) → claiming ${jobs.length} device(s)`);
		const owner = ownerResolver.resolve(ctx);
		const { platform } = clamped.flags.request;
		// capacity on and the host fits fewer workers than wanted: start with what fits, the rest join later
		const elastic = await this.elasticSplit(ctx, owner, clamped, name);
		const { lease } = elastic;
		const wanted = (lease.legs?.map((leg) => leg.flags) ?? [lease.flags])
			.map((flags) => `${flags.request.count} ${flags.request.profile}`)
			.join(" + ");
		const batchId = deps.newId();
		const batchDir = lease.record ?? join(storeLocator.wardenHome(ctx.env), "batches", batchId);
		const logDir = lease.logs ?? join(batchDir, "logs");
		const controller = new AbortController();
		const interrupted = () => controller.signal.aborted;
		const run: SessionRun = { launch: undefined, claimDone: false };
		const warm = this.startSessionWarm(ctx, deps, hooks, lease, elastic.extra, logDir, controller.signal);
		// each device is slimmed the moment it is leased, alongside its app install and warm-up (12-4)
		const slim =
			hooks.setup?.slim && platform === "ios"
				? batchSetup.startEarlySlim<ClaimedDevice>({
						slim: this.recordedSlim(ctx, deps, typeof hooks.setup.slim === "object" ? hooks.setup.slim : undefined),
						skip: (c) => leaseModel.isPhysicalDevice(c.device) || this.alreadySlimmed(ctx, c),
					})
				: undefined;
		// the early warm-up closed and the early slim done, once (before a failed claim releases the devices)
		let quiet: Promise<void> | undefined;
		const quiesce = () => {
			quiet ??= this.closeWarm(warm).then(() => slim?.settled());
			return quiet;
		};
		const offSignals = (["SIGINT", "SIGTERM"] as const).map((signal) =>
			deps.onSignal(signal, () => {
				controller.abort();
				void run.launch?.stop();
			})
		);
		const claimed = await spinnerContext.withSpinner(
			ctx,
			`claiming ${wanted} ${platform} device(s)…`,
			async (sctx, spinner) => {
				const legFlags = lease.legs?.map((leg) => leg.flags);
				const progress = leaseOptions.leasedProgress(spinner, ctx.ui.color, lease.app !== undefined);
				const onLeased = this.sessionOnLeased(progress, warm, slim);
				const onAppPhase = leaseOptions.appPhaseProgress(spinner, lease.app !== undefined);
				const onPorts = this.sessionOnPorts(ctx, sctx, deps, lease, run, batchDir, controller);
				const claimArgs = {
					...lease,
					self: autoGc.selfCommand(),
					...(legFlags ? { legFlags } : {}),
					...(onLeased ? { onLeased } : {}),
					...(onAppPhase ? { onAppPhase } : {}),
					...(onPorts ? { onPorts } : {}),
					aborted: () => interrupted() || run.launch?.state === "failed",
					// a device the headless hide could not boot again is dropped, as one that cannot reach Metro is (12-7, R5)
					dropLost: true,
					// a failed leg releases the others at once: their early slim and warm-up end first (R3)
					...(warm || slim ? { beforeRelease: quiesce } : {}),
				};
				const result = await new LeaseSessionRunner(leaseHostBuilder.leaseHostFromContext(sctx), deps).claimAll(
					owner,
					claimArgs,
					name
				);
				run.claimDone = true;
				// after claimAll: the run's own leases keep the background gc off its devices (12-2, 16-1)
				autoGc.maybeAutoGc(ctx);
				this.settleClaimSpinner(spinner, lease, result);
				return result;
			}
		);
		// before supervise re-subscribes (holdLeases), so the two never share a handler slot
		for (const off of offSignals) off();
		if (!claimed.success || interrupted()) return this.abortClaim(ctx, name, claimed, run, interrupted(), quiesce);
		return this.supervise(
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
				metro: run.launch,
				warm,
				slim,
				elastic: elastic.setup,
			}
		);
	}

	/**
	 * Elastic workers: with capacity on, a single-pool run that wants more devices than the host fits
	 * claims what fits now (the first claim queues normally) and the rest later, one at a time, at
	 * `PRIORITY.low`. `setup` is undefined (everything claimed at once, as without capacity) for suites
	 * with legs, a single worker, capacity off or when everything fits.
	 */
	private async elasticSplit(
		ctx: CommandContext,
		owner: Owner,
		args: BatchArgs,
		name: string
	): Promise<{ lease: BatchArgs; extra: number; setup: RunSetup["elastic"] }> {
		const { request } = args.flags;
		const whole = { lease: args, extra: 0, setup: undefined };
		// phones are not created: a physical request claims exactly the devices it names
		if (args.legs || request.count < 2 || request.physical !== undefined) return whole;
		const plan = await new ElasticPlanner(
			await new CapacityDepsBuilder(leaseHostBuilder.leaseHostFromContext(ctx)).build(owner)
		).plan(request.platform, request.count);
		if (!plan) return whole;
		output.note(
			ctx,
			`warden ${name}: host fits ${plan.first} of ${plan.first + plan.extra} ${request.platform} workers — starting with ${plan.first}, the rest join as capacity frees`
		);
		return {
			lease: { ...args, flags: { ...args.flags, request: { ...request, count: plan.first } } },
			extra: plan.extra,
			setup: { plan, flags: { ...args.flags, priority: PRIORITY.low, request: { ...request, count: 1 } } },
		};
	}

	/** Queue options shared by `warden batch` and `warden e2e`. */
	withBatchOptions<Args extends unknown[], Opts extends OptionValues, Globals extends OptionValues>(
		cmd: Commander<Args, Opts, Globals>
	) {
		return cmd
			.option("--retry <n>", "re-run a failed job up to N times on the same device", "0")
			.option("--passes <n>", "a job passes after N consecutive green runs on its device", "1")
			.option(
				"--serve <sh-cmd>",
				"start this (sh -c, own process group) before the jobs; killed at the end; {port} = the first leased port"
			)
			.option(
				"--serve-ready <probe>",
				"wait for http://…, tcp:PORT or file:PATH before starting jobs (tcp:{port} works)"
			)
			.option("--serve-timeout <duration>", "--serve-ready: give up after this long", "10m")
			.option("--job-timeout <duration>", "kill a job still running after this long (it counts as failed)")
			.option("--record <dir>", "iOS: record every simulator + the TUI into DIR (batch.json, tui.cast, dev-<i>.mp4)")
			.option("--logs <dir>", "per-job logs (default: <record dir>/logs or $WARDEN_HOME/batches/<id>/logs)")
			.option("--no-tui", "plain log lines instead of the live grid");
	}
}

export const batch = new BatchCommand(defaultBatchDeps);
export const batchCommand = batch.definition();
