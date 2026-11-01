import type { LogEntry, LogLevel } from "@delacour/warden-perf/logs/levels";
import type { Finding } from "@delacour/warden-perf/shared/findings.types";
import type { PerfReportJson } from "@delacour/warden-perf/shared/report";
import type { CrashesResult } from "./ops/perf/crashes";
import type { FramesResult } from "./ops/perf/frames";
import type { HeapDiffResult, HeapSnapshotResult } from "./ops/perf/heap";
import type { JsResult } from "./ops/perf/js";
import type { LogsResult } from "./ops/perf/logs";
import type { SessionRow } from "./ops/perf/ls";
import type { MemoryResult } from "./ops/perf/memory";
import type { MetricsResult } from "./ops/perf/metrics";
import type { MarkResult, StartResult, StopResult } from "./ops/perf/session-ops";
import type { StartupResult } from "./ops/perf/startup";
import type { CallOptions } from "./sdk.types";

export type {
	CrashesResult,
	Finding,
	FramesResult,
	HeapDiffResult,
	HeapSnapshotResult,
	JsResult,
	LogEntry,
	LogsResult,
	MarkResult,
	MemoryResult,
	MetricsResult,
	PerfReportJson,
	SessionRow,
	StartResult,
	StartupResult,
	StopResult,
};

/** The app a perf call profiles: `app` here, else the session's app, else the foreground app. */
export type PerfAppParams = { app?: string };

/** Captures of a perf session. None named: metrics + frames + logs (cheap, observe-only). `all` is every one. */
/** {@link StartResult} plus what the session could not arm. */
export type PerfStartResult = StartResult & { warnings: string[] };

/** {@link StopResult} plus what the stop could not gather. */
export type PerfStopResult = StopResult & { warnings: string[] };

export type PerfStartParams = PerfAppParams & {
	js?: boolean;
	react?: boolean;
	/** `true`, or the flavour: `perfetto` (Android) / `simpleperf` */
	native?: boolean | "perfetto" | "simpleperf";
	metrics?: boolean;
	frames?: boolean;
	logs?: boolean;
	all?: boolean;
	/** restart the app so start-up is inside the session */
	relaunch?: boolean;
	/** clear the app data before the relaunch */
	reset?: boolean;
	/** session cap, e.g. `10m` (default 10m) */
	maxDuration?: string;
};

export type PerfStopParams = {
	/** build `report.md` / `report.json` (default true) */
	analyze?: boolean;
};

export type PerfStartupParams = PerfAppParams & {
	cold?: boolean;
	warm?: boolean;
	/** launches to time per kind, 1-20 (default 5) */
	runs?: number;
	/** iOS `approx` (default) or `xctrace`; Android is always `am-start` */
	method?: "approx" | "xctrace" | "am-start";
};

export type PerfMetricsParams = PerfAppParams & {
	/** time between samples, e.g. `1s` (min 200ms) */
	interval?: string;
	/** how long to sample, e.g. `10s` (default 3s) */
	duration?: string;
};

export type PerfMemoryParams = PerfAppParams & {
	/** capture a heap (iOS memgraph + leaks, Android hprof); pauses the app */
	snapshot?: boolean;
};

export type PerfFramesParams = PerfAppParams & {
	/** clear the OS frame counters after reading */
	reset?: boolean;
};

export type PerfJsParams = PerfAppParams & {
	/** how long to sample, e.g. `10s` (max 5m) */
	duration?: string;
	/** sampling period in microseconds (default 100) */
	samplingInterval?: number;
	/** Metro to attach through (default: the one serving the device) */
	metro?: string;
};

export type PerfHeapSnapshotParams = PerfAppParams & { metro?: string };

export type PerfLogsParams = PerfAppParams & {
	/** minimum level */
	level?: LogLevel | "verbose" | "debug" | "info" | "warn" | "error" | "fatal";
	/** keep lines whose tag or message matches (case-insensitive regex) */
	grep?: string;
	/** only lines from the last `30s` | `5m` | `1h` */
	since?: string;
	/** lines to return, newest last (default 200) */
	lines?: number;
};

export type PerfCrashesParams = PerfAppParams & {
	since?: string;
	/** resolve iOS app frames through `dsym` */
	symbolicate?: boolean;
	dsym?: string;
};

/** The perf session of one device. A session holds the device lease, so mutating captures (start-up, relaunch, heap) are allowed. */
export type SessionPerfNamespace = {
	/** Arm a perf session on this device: detached collector plus the chosen capturers. One session per device. */
	start(params?: PerfStartParams, opts?: CallOptions): Promise<PerfStartResult>;
	/** Label the running session; hangs and jank are tagged with the last mark before them. */
	mark(label: string, opts?: CallOptions): Promise<MarkResult>;
	/** End the running session: stop the captures and (default) build its report. */
	stop(params?: PerfStopParams, opts?: CallOptions): Promise<PerfStopResult>;
	/** The device's active perf session, or null. */
	status(opts?: CallOptions): Promise<SessionRow | null>;
	/** Cold / warm start time, median and p90 over `runs`. Kills and relaunches the app. */
	startup(params?: PerfStartupParams, opts?: CallOptions): Promise<StartupResult>;
	/** CPU % and memory of the app as a time series. */
	metrics(params?: PerfMetricsParams, opts?: CallOptions): Promise<MetricsResult>;
	/** Where the app's memory sits now; `snapshot` captures a heap. */
	memory(params?: PerfMemoryParams, opts?: CallOptions): Promise<MemoryResult>;
	/** fps, janky %, dropped and frozen frames (Android; iOS reports `unsupported`). */
	frames(params?: PerfFramesParams, opts?: CallOptions): Promise<FramesResult>;
	/** A Hermes JS CPU profile of the dev client, source-mapped to hotspots. */
	js(params?: PerfJsParams, opts?: CallOptions): Promise<JsResult>;
	heap: {
		/** A Hermes heap snapshot of the dev client; freezes the JS thread while it is taken. */
		snapshot(params?: PerfHeapSnapshotParams, opts?: CallOptions): Promise<HeapSnapshotResult>;
		/** Constructor count and size deltas between two `.heapsnapshot` files. */
		diff(before: string, after: string, opts?: CallOptions): Promise<HeapDiffResult>;
	};
	/** The app's device logs (secrets redacted). `follow: true` streams until the signal aborts. */
	logs(params: PerfLogsParams & { follow: true }, opts?: CallOptions): AsyncIterable<LogEntry>;
	logs(params?: PerfLogsParams & { follow?: false }, opts?: CallOptions): Promise<LogsResult>;
	/** Crashes and ANRs of the app. */
	crashes(params?: PerfCrashesParams, opts?: CallOptions): Promise<CrashesResult>;
};

/** Recorded perf sessions of this machine. */
export type PerfNamespace = {
	/** Recorded sessions, newest first, optionally one device's. */
	ls(params?: { device?: string }, opts?: CallOptions): Promise<SessionRow[]>;
	/** The merged report of a finished session (id, unique prefix or `latest`); built from its files when missing. */
	report(id: string, opts?: CallOptions): Promise<PerfReportJson>;
};
