import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CpuProfile, cpuProfileSchema } from "@delacour/warden-perf/js/cpu-profile";
import type { Hotspots } from "@delacour/warden-perf/js/hotspots";
import type { JsCdp } from "@delacour/warden-perf/js/js.types";
import {
	analyzeReact,
	type ComponentSource,
	type ReactAnalysis,
	reactSection,
} from "@delacour/warden-perf/react/analyze";
import { type CpuIndex, type FrameLabel, indexProfile } from "@delacour/warden-perf/react/pipeline/cpu-correlate";
import { hotCommits } from "@delacour/warden-perf/react/pipeline/hot-commits";
import { reduceComponents } from "@delacour/warden-perf/react/pipeline/reduce";
import { startReactProfile, stopReactProfile } from "@delacour/warden-perf/react/profiler";
import type { CommitsFile, ReactError, ReactResult } from "@delacour/warden-perf/react/react.types";
import { reactErr, reactOk } from "@delacour/warden-perf/react/react.types";
import type { Finding } from "@delacour/warden-perf/shared/findings.types";
import type { ReportSection } from "@delacour/warden-perf/shared/render-md";
import { type UiError, uiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { CPU_FILE, HOTSPOTS_FILE } from "./js-capture";
import { COMMITS_FILE, FINDINGS_FILE } from "./react-out";
import { defaultSourceDeps, resolveSources, type SourceDeps } from "./react-source";

const NAMES_TO_LOCATE = 40;

/** A React profiling failure as a `warden perf` error. The runtime's three typed causes keep their code in the message and `details.react`. */
export function reactUiError(error: ReactError): UiError {
	const extra = { ...(error.hint === undefined ? {} : { hint: error.hint }), details: { react: error.code } };
	switch (error.code) {
		case "rn_too_old":
		case "devtools_backend_missing":
			return uiError("engine_unavailable", `${error.code}: ${error.message}`, extra);
		case "release_build":
			return uiError("not_profileable", `${error.code}: ${error.message}`, extra);
		case "session_active":
			return uiError("session_active", error.message, {
				...extra,
				details: { react: error.code, ...(error.owner === undefined ? {} : { owner: error.owner }) },
			});
		default:
			return uiError("failed", error.message, extra);
	}
}

/** Who holds the profile: stable across the `start` and `stop` invocations of one agent or shell, distinct between two. */
export async function reactOwner(ctx: CommandContext): Promise<string> {
	const { resolveOwner } = await import("../claim-flags");
	const owner = resolveOwner(ctx);
	if (owner.kind === "agent") return `agent:${owner.sessionId}`;
	if (owner.kind === "user") return `user:${owner.pid}`;
	return `ci:${owner.runId}`;
}

export type CpuCorrelation = { index: CpuIndex; label: FrameLabel };

/**
 * The session's JS profile as a lookup by device wall time, when `js/cpu.cpuprofile` and `js/hotspots.json` (its
 * clock anchor) are both there. Frames are named from the hotspot table (source-mapped `file:line`) by function
 * name, else by the script position.
 */
export function loadCpuCorrelation(jsDir: string | undefined): CpuCorrelation | undefined {
	if (jsDir === undefined) return undefined;
	const cpuPath = join(jsDir, CPU_FILE);
	const hotspotsPath = join(jsDir, HOTSPOTS_FILE);
	if (!existsSync(cpuPath) || !existsSync(hotspotsPath)) return undefined;
	try {
		const parsed = cpuProfileSchema.safeParse(JSON.parse(readFileSync(cpuPath, "utf8")));
		const hotspots = JSON.parse(readFileSync(hotspotsPath, "utf8")) as Partial<Hotspots>;
		const start = hotspots.anchor?.deviceWallMs;
		if (!parsed.success || start === undefined) return undefined;
		const profile: CpuProfile = parsed.data;
		const known = new Map<string, { file: string; line: number }>();
		for (const fn of [...(hotspots.topTotal ?? []), ...(hotspots.topSelf ?? [])]) {
			if (fn.mapped) known.set(fn.name, { file: fn.file, line: fn.line });
		}
		const label: FrameLabel = (frame) => {
			const mapped = known.get(frame.functionName);
			if (mapped !== undefined) return { name: frame.functionName, ...mapped };
			const name = frame.functionName === "" ? "(anonymous)" : frame.functionName;
			return frame.url === "" ? { name } : { name, file: frame.url, line: (frame.lineNumber ?? 0) + 1 };
		};
		return { index: indexProfile(profile, start), label };
	} catch {
		return undefined;
	}
}

export type ReactOutputs = {
	/** `<session>/react` */
	dir: string;
	/** the session's `js/` dir, for CPU correlation */
	jsDir?: string;
	cwd: string;
	sessionId?: string;
	sourceDeps?: SourceDeps;
};

export type ReactCaptureResult = {
	commitsPath: string;
	findingsPath: string;
	file: CommitsFile;
	analysis: ReactAnalysis;
	findings: Finding[];
	section: ReportSection;
};

/** Names worth locating: the costliest components and whatever fills a hot commit. */
function namesToLocate(file: CommitsFile): string[] {
	const byCost = reduceComponents(file.commits)
		.sort((a, b) => b.sumSelfMs - a.sumSelfMs)
		.slice(0, NAMES_TO_LOCATE)
		.map((s) => s.name);
	const hot = hotCommits(file.commits).flatMap((h) => h.top.map((t) => t.name));
	return [...new Set([...byCost, ...hot])];
}

/**
 * Analyse a recording and write `react/commits.json` and `react/findings.json`: components located (the runtime's
 * `_debugSource`, else a grep of the project), hot commits correlated with the session's JS CPU profile when there is
 * one.
 */
export function analyzeAndWrite(file: CommitsFile, out: ReactOutputs): ReactCaptureResult {
	const located = resolveSources(namesToLocate(file), out.cwd, file.sources, out.sourceDeps ?? defaultSourceDeps);
	const cpu = loadCpuCorrelation(out.jsDir);
	const analysis = analyzeReact(file, {
		...(out.sessionId === undefined ? {} : { sessionId: out.sessionId }),
		locate: (name): ComponentSource | undefined => located.get(name),
		...(cpu === undefined ? {} : { cpu }),
	});
	mkdirSync(out.dir, { recursive: true });
	const commitsPath = join(out.dir, COMMITS_FILE);
	const findingsPath = join(out.dir, FINDINGS_FILE);
	writeFileSync(commitsPath, JSON.stringify(file));
	writeFileSync(findingsPath, `${JSON.stringify(analysis, null, 2)}\n`);
	return { commitsPath, findingsPath, file, analysis, findings: analysis.findings, section: reactSection(analysis) };
}

export type ReactStartResult = { startedWallMs: number; dev: boolean; rn: string | null; bootstrapped: boolean };

/** Begin React profiling in the app; the profile lives in its runtime until `stopReactCapture`. */
export async function startReactCapture(
	cdp: JsCdp,
	options: { owner: string; force?: boolean }
): Promise<ReactResult<ReactStartResult>> {
	const started = await startReactProfile(cdp, options);
	if (!started.success) return started;
	const { startedWall, dev, rn, bootstrapped } = started.data;
	return reactOk({ startedWallMs: startedWall, dev, rn, bootstrapped });
}

/** End React profiling, then analyse and write (see `analyzeAndWrite`). `hostWallMs` = host clock at start, for alignment. */
export async function stopReactCapture(
	cdp: JsCdp,
	options: ReactOutputs & { owner: string; force?: boolean; hostWallMs?: number }
): Promise<ReactResult<ReactCaptureResult>> {
	const stopped = await stopReactProfile(cdp, {
		owner: options.owner,
		...(options.force === undefined ? {} : { force: options.force }),
		...(options.hostWallMs === undefined ? {} : { hostWallMs: options.hostWallMs }),
	});
	if (!stopped.success) return stopped;
	try {
		return reactOk(analyzeAndWrite(stopped.data, options));
	} catch (error) {
		return reactErr(
			"invalid_data",
			`could not write the React report: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

export type RunReactCaptureOptions = ReactOutputs & {
	owner: string;
	force?: boolean;
	durationMs: number;
	/** stops the capture early (the session collector's SIGTERM); what was recorded so far is still written */
	signal?: AbortSignal;
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	now?: () => number;
	/** called once profiling runs, with the alignment anchor */
	onStarted?: (started: ReactStartResult & { hostWallMs: number }) => void;
};

/** Start, wait `durationMs` (or until `signal` aborts), stop and write: the session collector's one call. */
export async function runReactCapture(
	cdp: JsCdp,
	options: RunReactCaptureOptions
): Promise<ReactResult<ReactCaptureResult>> {
	const hostWallMs = (options.now ?? Date.now)();
	const started = await startReactCapture(cdp, {
		owner: options.owner,
		...(options.force === undefined ? {} : { force: options.force }),
	});
	if (!started.success) return started;
	options.onStarted?.({ ...started.data, hostWallMs });
	await options.sleep(options.durationMs, options.signal);
	return stopReactCapture(cdp, { ...options, hostWallMs });
}
