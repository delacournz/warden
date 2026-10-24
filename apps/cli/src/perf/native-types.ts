import { closeSync, openSync } from "node:fs";
import { processAlive } from "@delacour/warden-core/liveness";
import type { Finding } from "@delacour/warden-perf/shared/findings.types";
import type { ReportSection } from "@delacour/warden-perf/shared/render-md";
import type { Result } from "@delacour/warden-types/result";
import type { UiError } from "../agent-ui/output";
import { processCommand } from "../agent-ui/process-identity";
import type { CommandContext } from "../context";
import type { PerfTarget } from "./device";
import type { PerfDeps } from "./run";

/** Effects a native profiler reaches the host through (detached recorder, signals, clock); tests inject fakes. */
export type NativeIo = {
	/** start the recorder detached from this process (survives our exit) */
	spawnDetached: (spec: { argv: string[]; logPath: string }) => { pid: number };
	kill: (pid: number, signal: "SIGINT" | "SIGTERM" | "SIGKILL") => void;
	pidAlive: (pid: number) => boolean;
	/** a pid's command line: the recorded pid is signalled only while it still carries the recorder's argv. Absent: liveness alone */
	command?: ((pid: number) => string | undefined) | undefined;
	sleep: (ms: number) => Promise<void>;
};

export const defaultNativeIo: NativeIo = {
	spawnDetached: ({ argv, logPath }) => {
		const log = openSync(logPath, "a");
		try {
			const proc = Bun.spawn(argv, { stdin: "ignore", stdout: log, stderr: log, detached: true });
			proc.unref();
			return { pid: proc.pid };
		} finally {
			closeSync(log);
		}
	},
	kill: (pid, signal) => {
		try {
			process.kill(pid, signal);
		} catch {
			// already gone
		}
	},
	pidAlive: processAlive,
	command: processCommand,
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type NativeStartInput = {
	target: PerfTarget;
	app: string;
	/** absolute `<session or one-shot dir>/native` (created by the caller) */
	dir: string;
	/** iOS: MUTATE cold launch with MallocStackLogging so Leaks has allocation stacks */
	leaks: boolean;
	/** the raw `--native=<flavor>` value (e.g. `simpleperf`); iOS ignores it */
	flavor?: string;
	maxDurationMs: number;
};

/** What `start` leaves behind: persisted as the session's `native` capturer, or in the one-shot `state.json`. */
export type NativeHandle = {
	/** host pid of the detached recorder */
	pid?: number;
	/** primary artifact path (iOS: `native/ios.trace`) */
	out: string;
	startedAtIso: string;
	/** host clock at start */
	startWallMs: number;
	/** device clock at start (alignment anchor) */
	deviceWallMs?: number;
	/** JSON-safe extras `stop` needs again */
	state?: Record<string, string | number | boolean>;
};

export type NativeAnalysis = {
	findings: Finding[];
	/** markdown section for `report.md` */
	section: ReportSection;
	summary: string[];
	/** artifact name → absolute path */
	files: Record<string, string>;
	/** JSON-safe piece for `report.json` */
	report: unknown;
	warnings: string[];
};

export type NativeStopInput = {
	target: PerfTarget;
	app: string;
	dir: string;
	handle: NativeHandle;
	analyze: boolean;
};

export type NativeStopped = { out: string; analysis?: NativeAnalysis; warnings: string[] };

export type NativeAnalyzeInput = {
	target: PerfTarget;
	app: string;
	dir: string;
	trace: string;
	windowMs?: { startMs: number; endMs: number };
};

/** One platform's native profiler (`warden perf native`): iOS xctrace, Android perfetto/simpleperf. */
export type NativeProfiler = {
	start: (
		ctx: CommandContext,
		deps: PerfDeps,
		io: NativeIo,
		input: NativeStartInput
	) => Promise<Result<NativeHandle, UiError>>;
	stop: (
		ctx: CommandContext,
		deps: PerfDeps,
		io: NativeIo,
		input: NativeStopInput
	) => Promise<Result<NativeStopped, UiError>>;
	analyze: (ctx: CommandContext, deps: PerfDeps, input: NativeAnalyzeInput) => Promise<Result<NativeAnalysis, UiError>>;
};
