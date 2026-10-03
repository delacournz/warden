import { closeSync, mkdirSync, openSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Command as Commander, OptionValues } from "@commander-js/extra-typings";
import { expandArgv, jobSlug, parseJobLines, parseJobList } from "@delacour/warden-core/batch/expand";
import { type BatchJobsSource, type BatchPreset, findBatchPreset } from "@delacour/warden-core/batch/preset";
import { type BatchEvent, type BatchSummary, type BatchWorker, runBatch } from "@delacour/warden-core/batch/schedule";
import { parseDuration } from "@delacour/warden-core/duration";
import { execError } from "@delacour/warden-core/exec";
import { isPortFree } from "@delacour/warden-core/ports";
import { wardenHome } from "@delacour/warden-core/store";
import type { Platform } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { maybeAutoGc } from "../autogc";
import { type Cast, createCast } from "../batch/cast";
import { type Recording, startSimRecording, videoName } from "../batch/record";
import { parseReadySpec, probeReady, type ReadySpec } from "../batch/serve";
import { applyEvent, type BatchView, initialView, type LiveScreen, liveScreen, plainLine, render } from "../batch/tui";
import { type ClaimFlagValues, parseClaimFlags, resolveOwner, resolvePlatform, withClaimOptions } from "../claim-flags";
import { type Command, defineCommand } from "../command";
import type { CommandContext } from "../context";
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
	/** write a file, creating its parent dirs */
	writeFile: (path: string, data: string) => Promise<void>;
	readFile: (path: string) => Promise<string>;
	mkdir: (dir: string) => Promise<void>;
	newId: () => string;
	terminal: Terminal;
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
		record?: string;
		logs?: string;
		/** false = `--no-tui` */
		tui: boolean;
	};

type Serve = { cmd: string; ready?: ReadySpec; timeoutMs: number };

type BatchArgs = LeaseArgs & {
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
};

const SERVE_KILL_GRACE_MS = 15_000;
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
	const ready = parseReadySpec(opts.serveReady, cwd);
	return ready.success ? ok({ cmd: opts.serve, timeoutMs: timeoutMs.data, ready: ready.data }) : ready;
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
	if (!/^\d+$/.test(opts.retry)) return err(`--retry must be an integer >= 0, got "${opts.retry}"`);
	if (!/^\d+$/.test(opts.passes) || Number(opts.passes) < 1)
		return err(`--passes must be an integer >= 1, got "${opts.passes}"`);
	const serve = parseServe(opts, cwd);
	if (!serve.success) return serve;
	if (opts.record !== undefined && platform !== "ios") return err("--record is iOS-only");
	return ok({
		flags: flags.data,
		ports: opts.port,
		json: opts.json === true,
		jobs: jobs.data,
		retry: Number(opts.retry),
		passes: Number(opts.passes),
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
	proc: ProcHandle,
	aborted: () => boolean
): AsyncResult<void> {
	let exitCode: number | undefined;
	void proc.exited.then((code) => {
		exitCode = code;
	});
	const ready = serve.ready;
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

type Device = BatchWorker & { name: string; video?: string; videoStartedAt?: number };

/** The `batch.json` document (record-dir contract; also the `--json` output). */
function summaryJson(
	batchId: string,
	cmd: string[],
	startedAt: number,
	endedAt: number,
	devices: Device[],
	summary: BatchSummary
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
			...(d.video !== undefined ? { video: d.video, videoStartedAt: d.videoStartedAt } : {}),
		})),
		jobs: summary.results.map((r) => ({
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
	env: Record<string, string | undefined>;
	cwd: string;
	logDir: string;
	passes: number;
	running: Set<ProcHandle>;
	interrupted: () => boolean;
};

/**
 * The per-job `run` for `runBatch`: expand the argv, spawn with the job env + log, track it for
 * SIGINT. With `passes` > 1 the job is spawned again after each green run (`WARDEN_PASS`, one log
 * per pass); the first red run is the attempt's exit code.
 */
function jobRunner(deps: BatchDeps, o: JobRunnerOptions) {
	const spawnOnce = async (w: BatchWorker, job: string, seq: number, pass: number): Promise<number> => {
		const jobEnv = {
			...o.env,
			WARDEN_UDID: w.udid,
			WARDEN_WORKER: String(w.worker),
			WARDEN_JOB: job,
			WARDEN_JOB_SEQ: String(seq),
			WARDEN_PASS: String(pass),
		};
		const suffix = o.passes > 1 ? `.pass${pass}` : "";
		const log = join(o.logDir, `${w.worker}-${seq}-${jobSlug(job)}${suffix}.log`);
		const argv = o.hooks.argvFor ? o.hooks.argvFor(job) : o.cmd;
		let proc: ProcHandle;
		try {
			proc = deps.spawn(expandArgv(argv, { job, udid: w.udid, worker: w.worker, seq }), {
				env: jobEnv,
				log,
				cwd: o.cwd,
			});
		} catch {
			return 127;
		}
		o.running.add(proc);
		try {
			return await proc.exited;
		} finally {
			o.running.delete(proc);
		}
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
	cast?: Cast;
};

/** Write `batch.json` (+ `tui.cast`), print `--json` / the closing lines. */
async function report(ctx: CommandContext, deps: BatchDeps, args: BatchArgs, r: BatchRun): Promise<void> {
	const doc = summaryJson(r.batchId, r.cmd, r.startedAt, r.endedAt, r.devices, r.summary);
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
export type SessionResult = { code: number; batchDir?: string; summary?: BatchSummary };

/** Extras for callers building on batch (`warden e2e`). */
export type SessionHooks = { argvFor?: ArgvFor; name?: string };

/** Everything after the claim: serve → recordings → jobs → stop serve → stop recordings → batch.json → release. */
async function supervise(
	ctx: CommandContext,
	deps: BatchDeps,
	args: BatchArgs,
	jobs: string[],
	cmd: string[],
	session: LeaseSession,
	hooks: SessionHooks & { name: string }
): Promise<SessionResult> {
	const { name } = hooks;
	const batchId = deps.newId();
	const batchDir = args.record ?? join(wardenHome(ctx.env), "batches", batchId);
	const logDir = args.logs ?? join(batchDir, "logs");
	const env = { ...session.env, ...args.env, WARDEN_BATCH_DIR: batchDir };
	const devices: Device[] = session.outcome.claimed.map((c, worker) => ({
		worker,
		udid: c.device.id,
		name: c.device.name,
	}));
	const controller = new AbortController();
	const running = new Set<ProcHandle>();
	const stopHold = holdLeases(ctx, deps, session.leaseIds, (signal) => {
		controller.abort();
		for (const job of running) job.kill(signal);
	});
	const interrupted = () => controller.signal.aborted;
	let serve: ProcHandle | undefined;
	let recordings: Recording[] = [];
	const fail = (message: string): SessionResult => {
		ctx.err(ctx.ui.color.red(`warden ${name}: ${message}`));
		return { code: interrupted() ? 130 : 1 };
	};
	/** workers are done: serve first, then the recordings (the contract's stop order) */
	const teardown = async () => {
		const [proc, recs] = [serve, recordings];
		serve = undefined;
		recordings = [];
		if (proc) await stopServe(deps, proc);
		await Promise.all(recs.map((r) => r.stop()));
	};
	try {
		await deps.mkdir(logDir);
		if (args.serve) {
			const log = join(logDir, "serve.log");
			serve = deps.spawn(["sh", "-c", args.serve.cmd], { env, log, group: true, cwd: args.cwd });
			const ready = await waitReady(ctx, deps, args.serve, serve, interrupted);
			if (!ready.success) return fail(`${ready.error} (log: ${log})`);
		}
		if (args.record) {
			const started = await startRecordings(deps, args.record, devices);
			if (!started.success) return fail(started.error);
			recordings = started.data;
		}
		const startedAt = ctx.now();
		const screen = display(ctx, deps, args, { current: initialView(devices, jobs.length, startedAt) });
		const summary = await runBatch({
			workers: devices,
			jobs,
			retry: args.retry,
			now: ctx.now,
			signal: controller.signal,
			onEvent: screen.event,
			run: jobRunner(deps, { cmd, env, cwd: args.cwd, logDir, passes: args.passes, running, interrupted, hooks }),
		});
		const endedAt = ctx.now();
		screen.end();
		await teardown();
		const run: BatchRun = { batchId, batchDir, logDir, cmd, devices, total: jobs.length, startedAt, endedAt, summary };
		await report(ctx, deps, args, screen.cast ? { ...run, cast: screen.cast } : run);
		if (interrupted()) return { code: 130, batchDir, summary };
		return { code: summary.ok ? 0 : 1, batchDir, summary };
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

/** More devices than jobs would idle: claim at most one device per job (same `args` when no change). */
export function clampToJobs(args: BatchArgs, jobCount: number): BatchArgs {
	const { request } = args.flags;
	if (jobCount >= request.count) return args;
	return { ...args, flags: { ...args.flags, request: { ...request, count: Math.max(1, jobCount) } } };
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
	const { count, profile, platform } = lease.flags.request;
	const claimed = await withSpinner(
		ctx,
		`claiming ${count} ${profile} ${platform} device(s)…`,
		async (sctx, spinner) => {
			const result = await claimAll(sctx, deps, owner, lease, name);
			if (result.success) spinner.succeed(`leased ${result.data.outcome.claimed.map((c) => c.device.name).join(", ")}`);
			else spinner.fail("claim failed");
			return result;
		}
	);
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
		.option("--serve <sh-cmd>", "start this (sh -c, own process group) before the jobs; killed at the end")
		.option("--serve-ready <probe>", "wait for http://…, tcp:PORT or file:PATH before starting jobs")
		.option("--serve-timeout <duration>", "--serve-ready: give up after this long", "10m")
		.option("--record <dir>", "iOS: record every simulator + the TUI into DIR (batch.json, tui.cast, dev-<i>.mp4)")
		.option("--logs <dir>", "per-job logs (default: <record dir>/logs or $WARDEN_HOME/batches/<id>/logs)")
		.option("--no-tui", "plain log lines instead of the live grid");
}

/**
 * `warden batch [platform|preset] [claim options] (--jobs …|--jobs-from …) [--serve …] [--record dir] [-- <cmd…>]`.
 * A preset is `batches.<name>` in `warden.config.json`; flags passed alongside it override it.
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
								"ios | android (asked for when omitted in a terminal), or a warden.config.json batches preset"
							)
							.argument("[cmd...]", "per-job command after --; {job} {udid} {worker} {seq} are substituted")
					)
				)
			)
				.option("--jobs <list>", "comma-separated jobs")
				.option("--jobs-from <file>", "one job per line from a file, or - for stdin")
				.addHelpText(
					"after",
					"\nExamples:\n  warden batch ios --count 3 --jobs a,b,c,d -- bun e2e --flow {job} --device {udid}\n  warden batch e2e --count 2    # batches.e2e from warden.config.json, --count overridden"
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
};

export const batchCommand: Command = createBatchCommand(defaultBatchDeps);
