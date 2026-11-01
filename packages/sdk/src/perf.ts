import type { LogEntry } from "@delacour/warden-perf/logs/levels";
import type { Lease, Platform } from "@delacour/warden-store/types";
import type { WardenError as EngineError } from "@delacour/warden-types/error";
import type { Result } from "@delacour/warden-types/result";
import { type Core, guard, guarded, unwrap } from "./core";
import { fromThrown, toWardenError, WardenError } from "./errors";
import type { CrashDeps } from "./ops/perf/crashes";
import type { PerfUiEnv } from "./ops/perf/env";
import type { JsDeps } from "./ops/perf/js-capture";
import type { LogDeps, LogsResult } from "./ops/perf/logs";
import type { MemoryIo } from "./ops/perf/memory";
import type { SessionKit } from "./ops/perf/orchestrate";
import type { StartupIo } from "./ops/perf/startup";
import type { PerfEngineDeps, PerfTarget } from "./ops/perf/types";
import type {
	PerfCrashesParams,
	PerfHeapSnapshotParams,
	PerfLogsParams,
	PerfNamespace,
	PerfStartResult,
	PerfStartupParams,
	PerfStopResult,
	SessionPerfNamespace,
} from "./perf.types";
import type { CallOptions } from "./sdk.types";

/** Test seams of the perf facade: every one defaults to the real machine. */
export type PerfSeams = {
	/** session store + Metro lookup (default: the real process table and `state.json`) */
	deps?: PerfEngineDeps;
	/** how `start` / `stop` spawn the collector and the native recorders */
	kit?: SessionKit;
	startup?: StartupIo;
	memory?: MemoryIo;
	js?: JsDeps;
	logs?: LogDeps;
	crashes?: CrashDeps;
};

/** What a session's perf namespace needs of it. */
export type PerfSessionInit = {
	device: { id: string; platform: Platform; name?: string };
	lease: Lease;
	appId: string | undefined;
	/** true once the session closed */
	closed: () => boolean;
};

/** A session's perf namespace plus the hook its `close` runs. */
export type SessionPerf = { namespace: SessionPerfNamespace; stopOwn: () => Promise<void> };

/** How long a perf op waits on the device or Metro before giving up (the SDK is not interactive). */
const TIMEOUT_MS = 10_000;

const usage = (message: string): WardenError => new WardenError({ code: "usage", message });

/** The engine's env over the client's host: no colours, no prompts. */
function envOf(core: Core): PerfUiEnv {
	return {
		env: core.host.env,
		cwd: core.host.cwd,
		now: core.host.now,
		exec: core.host.exec,
		git: core.git,
		store: () => core.store(),
		ui: {
			color: { dim: (t) => t, green: (t) => t, red: (t) => t, yellow: (t) => t },
			interactive: false,
			rich: false,
			confirm: async () => false,
		},
		err: () => {},
	};
}

async function depsOf(core: Core): Promise<PerfEngineDeps> {
	const given = core.seams.perf?.deps;
	if (given) return given;
	const [{ defaultSessionDeps }, { defaultPerfHostDeps }] = await Promise.all([
		import("./ops/perf/session"),
		import("./ops/perf/host"),
	]);
	return { session: defaultSessionDeps, host: defaultPerfHostDeps };
}

async function kitOf(core: Core): Promise<SessionKit> {
	const given = core.seams.perf?.kit;
	if (given) return given;
	const [{ defaultNativeProfilers }, { defaultNativeIo }] = await Promise.all([
		import("./ops/perf/native"),
		import("./ops/perf/native-types"),
	]);
	const bin = core.host.env.WARDEN_BIN ?? "warden";
	return { io: { ...defaultNativeIo, self: () => [bin] }, profilers: defaultNativeProfilers };
}

function targetOf(init: PerfSessionInit): PerfTarget {
	return {
		udid: init.device.id,
		platform: init.device.platform,
		...(init.device.name !== undefined ? { name: init.device.name } : {}),
		ownedByCaller: true,
		lease: init.lease,
		source: "lease",
		mode: "mutate",
	};
}

/** Wait `ms`, or until `signal` aborts (a metrics run ends with the samples so far). */
const sleepUntil = (ms: number, signal: AbortSignal): Promise<void> =>
	new Promise((resolve) => {
		const finish = (): void => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal.addEventListener("abort", finish, { once: true });
	});

/** `runs`, `method` and `cold|warm` (default cold) as a startup plan. */
async function startupPlan(params: PerfStartupParams, platform: Platform) {
	const { DEFAULT_RUNS, MAX_RUNS } = await import("./ops/perf/startup");
	const count = params.runs ?? DEFAULT_RUNS;
	if (!Number.isInteger(count) || count < 1 || count > MAX_RUNS) throw usage(`runs must be an integer 1-${MAX_RUNS}`);
	let method: "am-start" | "simctl-approx" | "xctrace";
	if (platform === "android") {
		if (params.method !== undefined && params.method !== "am-start") throw usage("method is iOS only on Android");
		method = "am-start";
	} else if (params.method === undefined || params.method === "approx") {
		method = "simctl-approx";
	} else if (params.method === "xctrace") {
		method = "xctrace";
	} else {
		throw usage(`method must be approx or xctrace, got "${params.method}"`);
	}
	const kinds: Array<"cold" | "warm"> = [];
	if (params.cold === true || params.warm !== true) kinds.push("cold");
	if (params.warm === true) kinds.push("warm");
	return { count, method, kinds };
}

/** The `--level --grep --since --lines` flags of the log engine from `params`. */
function logFlags(params: PerfLogsParams) {
	return {
		...(params.level !== undefined ? { level: params.level } : {}),
		...(params.grep !== undefined ? { grep: params.grep } : {}),
		...(params.since !== undefined ? { since: params.since } : {}),
		...(params.lines !== undefined ? { lines: String(params.lines) } : {}),
	};
}

/**
 * The perf namespace of one session. A session holds the device lease, so the mutating captures (start-up,
 * relaunch, heap snapshots) run; a device the caller does not hold never gets a session.
 */
export function buildSessionPerf(core: Core, init: PerfSessionInit): SessionPerf {
	const env = envOf(core);
	const target = targetOf(init);
	const device = { platform: init.device.platform, id: init.device.id };
	let ownId: string | undefined;

	const run = <T>(opts: CallOptions | undefined, work: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> => {
		const signal = core.signalFor(opts);
		return guarded(signal, async () => {
			if (init.closed()) throw usage("session is closed");
			return work(signal);
		});
	};

	const appFor = async (flag: string | undefined): Promise<{ id: string }> => {
		const { resolveAppWith } = await import("./ops/perf/app");
		return unwrap(await resolveAppWith(env, device, flag ?? init.appId));
	};

	const done = async <R>(outcome: Promise<Result<{ result: R }, EngineError>>): Promise<R> =>
		unwrap(await outcome).result;

	const logsOnce = (params: PerfLogsParams, opts: CallOptions | undefined): Promise<LogsResult> =>
		run(opts, async () => {
			const { logsWork, parseFlags } = await import("./ops/perf/logs");
			const flags = unwrap(parseFlags(logFlags(params)));
			const app = await appFor(params.app);
			return done(logsWork(env, target, app, flags, TIMEOUT_MS));
		});

	async function* logsFollow(
		params: PerfLogsParams,
		opts: CallOptions | undefined
	): AsyncGenerator<LogEntry, void, void> {
		if (init.closed()) throw usage("session is closed");
		const signal = core.signalFor(opts);
		guard(signal);
		const stop = new AbortController();
		const onAbort = (): void => stop.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const { followLogEntries, LogStreamError, parseFlags, defaultLogDeps } = await import("./ops/perf/logs");
			const flags = unwrap(parseFlags(logFlags(params)));
			const app = await appFor(params.app);
			try {
				yield* followLogEntries(env, target, app, flags, stop.signal, core.seams.perf?.logs ?? defaultLogDeps);
			} catch (error) {
				throw error instanceof LogStreamError ? toWardenError(error.error) : fromThrown(error, signal);
			}
		} finally {
			signal?.removeEventListener("abort", onAbort);
			stop.abort();
		}
	}

	function logs(params: PerfLogsParams & { follow: true }, opts?: CallOptions): AsyncIterable<LogEntry>;
	function logs(params?: PerfLogsParams & { follow?: false }, opts?: CallOptions): Promise<LogsResult>;
	function logs(
		params: PerfLogsParams & { follow?: boolean } = {},
		opts?: CallOptions
	): AsyncIterable<LogEntry> | Promise<LogsResult> {
		return params.follow === true ? logsFollow(params, opts) : logsOnce(params, opts);
	}

	const start: SessionPerfNamespace["start"] = (params, opts) =>
		run(opts, async (): Promise<PerfStartResult> => {
			const [{ startPerf }, { startResult }, { resolveAppWith }, deps, kit] = await Promise.all([
				import("./ops/perf/orchestrate"),
				import("./ops/perf/session-ops"),
				import("./ops/perf/app"),
				depsOf(core),
				kitOf(core),
			]);
			const out = unwrap(
				await startPerf(env, deps, kit, target, params ?? {}, {
					resolveApp: (_target, flag) => resolveAppWith(env, device, flag ?? init.appId),
				})
			);
			ownId = out.session.id;
			return {
				...startResult(env, out, "session.perf.stop()"),
				next: ["session.perf.mark(label)", "session.perf.stop()"],
				warnings: out.warnings,
			};
		});

	const stop: SessionPerfNamespace["stop"] = (params, opts) =>
		run(opts, async (): Promise<PerfStopResult> => {
			const [{ finalizeSession }, { runningSessionFor }, { stopResult }, deps, kit] = await Promise.all([
				import("./ops/perf/orchestrate"),
				import("./ops/perf/session"),
				import("./ops/perf/session-ops"),
				depsOf(core),
				kitOf(core),
			]);
			const running = runningSessionFor(env, target.udid);
			if (running === undefined) {
				throw new WardenError({
					code: "session_not_found",
					message: `no running perf session on ${target.udid}`,
					hint: "session.perf.start()",
				});
			}
			const out = unwrap(
				await finalizeSession(env, deps, kit, running.id, { reason: "user", analyze: params?.analyze !== false })
			);
			if (ownId === running.id) ownId = undefined;
			return { ...stopResult(env, out), warnings: out.warnings };
		});

	const metrics: SessionPerfNamespace["metrics"] = (params, opts) =>
		run(opts, async (signal) => {
			const [{ metricsSeries, planSeries }, { androidFrameRate }, deps] = await Promise.all([
				import("./ops/perf/metrics"),
				import("./ops/perf/frames"),
				depsOf(core),
			]);
			const p = params ?? {};
			const planned = unwrap(
				planSeries({
					...(p.interval !== undefined ? { interval: p.interval } : {}),
					...(p.duration !== undefined ? { duration: p.duration } : {}),
				})
			);
			const app = await appFor(p.app);
			const abort = new AbortController();
			const onAbort = (): void => abort.abort();
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				const result = await done(
					metricsSeries(env, deps, target, app.id, planned, {
						sleep: sleepUntil,
						signal: abort.signal,
						...(target.platform === "android"
							? { fps: async () => (await androidFrameRate(env, target.udid, app.id))?.fps }
							: {}),
					})
				);
				guard(signal);
				return result;
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
		});

	const namespace: SessionPerfNamespace = {
		start,
		stop,
		metrics,
		mark: (label, opts) =>
			run(opts, async () => {
				const [{ markWork }, deps] = await Promise.all([import("./ops/perf/session-ops"), depsOf(core)]);
				return done(markWork(env, deps, target, label));
			}),
		status: (opts) =>
			run(opts, async () => {
				const [{ activeSessionFor }, { rowOf }, deps] = await Promise.all([
					import("./ops/perf/session"),
					import("./ops/perf/ls"),
					depsOf(core),
				]);
				const session = activeSessionFor(env, deps.session, target.udid);
				return session === undefined ? null : rowOf(session, env.now());
			}),
		startup: (params, opts) =>
			run(opts, async () => {
				const [{ startupWork, defaultStartupIo }, deps] = await Promise.all([
					import("./ops/perf/startup"),
					depsOf(core),
				]);
				const p = params ?? {};
				const plan = await startupPlan(p, target.platform);
				const app = await appFor(p.app);
				return done(startupWork(env, deps, target, app.id, plan, core.seams.perf?.startup ?? defaultStartupIo));
			}),
		memory: (params, opts) =>
			run(opts, async () => {
				const [{ memoryWork, realMemoryIo }, { artifactDirFor }, deps] = await Promise.all([
					import("./ops/perf/memory"),
					import("./ops/perf/metrics-out"),
					depsOf(core),
				]);
				const p = params ?? {};
				const app = await appFor(p.app);
				const out = artifactDirFor(env, deps.session, target.udid);
				const io = core.seams.perf?.memory ?? realMemoryIo;
				return done(memoryWork(env, target, app.id, p.snapshot === true, out.dir, io));
			}),
		frames: (params, opts) =>
			run(opts, async () => {
				const [{ framesWork }, deps] = await Promise.all([import("./ops/perf/frames"), depsOf(core)]);
				const p = params ?? {};
				const app = await appFor(p.app);
				return done(framesWork(env, deps, target, app.id, p.reset === true));
			}),
		js: (params, opts) =>
			run(opts, async () => {
				const [{ jsWork, planJs }, { defaultJsDeps }, deps] = await Promise.all([
					import("./ops/perf/js"),
					import("./ops/perf/js-capture"),
					depsOf(core),
				]);
				const p = params ?? {};
				const planned = unwrap(
					planJs({
						...(p.duration !== undefined ? { duration: p.duration } : {}),
						...(p.samplingInterval !== undefined ? { samplingInterval: String(p.samplingInterval) } : {}),
					})
				);
				const app = await appFor(p.app);
				const js = core.seams.perf?.js ?? defaultJsDeps;
				return done(jsWork(env, deps, js, target, app.id, planned, p.metro, TIMEOUT_MS));
			}),
		heap: {
			snapshot: (params: PerfHeapSnapshotParams | undefined, opts) =>
				run(opts, async () => {
					const [{ heapSnapshotWork }, { defaultJsDeps }, deps] = await Promise.all([
						import("./ops/perf/heap"),
						import("./ops/perf/js-capture"),
						depsOf(core),
					]);
					const p = params ?? {};
					const app = await appFor(p.app);
					const js = core.seams.perf?.js ?? defaultJsDeps;
					return done(heapSnapshotWork(env, deps, js, target, app.id, p.metro, TIMEOUT_MS));
				}),
			diff: (before, after, opts) =>
				run(opts, async () => {
					const { heapDiffWork } = await import("./ops/perf/heap");
					return unwrap(heapDiffWork(env, before, after)).result;
				}),
		},
		logs,
		crashes: (params: PerfCrashesParams | undefined, opts) =>
			run(opts, async () => {
				const [{ crashesWork, defaultCrashDeps }, deps] = await Promise.all([
					import("./ops/perf/crashes"),
					depsOf(core),
				]);
				const p = params ?? {};
				const flags = {
					...(p.app !== undefined ? { app: p.app } : {}),
					...(p.since !== undefined ? { since: p.since } : {}),
					...(p.symbolicate === true ? { symbolicate: true as const } : {}),
					...(p.dsym !== undefined ? { dsym: p.dsym } : {}),
				};
				const { resolveAppWith } = await import("./ops/perf/app");
				const resolve = (flag: string | undefined) => resolveAppWith(env, device, flag ?? init.appId);
				const crashDeps = core.seams.perf?.crashes ?? defaultCrashDeps;
				return done(crashesWork(env, deps, target, flags, TIMEOUT_MS, resolve, crashDeps));
			}),
	};

	const stopOwn = async (): Promise<void> => {
		const id = ownId;
		if (id === undefined) return;
		ownId = undefined;
		try {
			const [{ finalizeSession }, { runningSessionFor }, deps, kit] = await Promise.all([
				import("./ops/perf/orchestrate"),
				import("./ops/perf/session"),
				depsOf(core),
				kitOf(core),
			]);
			if (runningSessionFor(env, target.udid)?.id !== id) return;
			await finalizeSession(env, deps, kit, id, { reason: "device-released", analyze: false });
		} catch {
			// the lease is released either way; a stale record is swept by the next start
		}
	};

	return { namespace, stopOwn };
}

/** Recorded perf sessions of this machine: list and report. */
export function buildPerf(core: Core): PerfNamespace {
	const env = envOf(core);
	return {
		ls: (params, opts) =>
			guarded(core.signalFor(opts), async () => {
				const { sessionRows } = await import("./ops/perf/ls");
				return sessionRows(env, params?.device);
			}),
		report: (id, opts) =>
			guarded(core.signalFor(opts), async () => {
				const [{ sessionByRef }, { readSessionReport, writeSessionReport }] = await Promise.all([
					import("./ops/perf/session-ref"),
					import("./ops/perf/report-read"),
				]);
				const session = unwrap(sessionByRef(env, id));
				if (session.status === "running") {
					throw new WardenError({
						code: "session_active",
						message: `session ${session.id} is still running`,
						hint: "stop it first: session.perf.stop()",
					});
				}
				return readSessionReport(env, session.id) ?? writeSessionReport(env, session);
			}),
	};
}
