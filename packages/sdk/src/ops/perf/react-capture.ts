import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CpuProfile, cpuProfileSchema } from "@delacour/warden-perf/js/cpu-profile";
import type { Hotspots } from "@delacour/warden-perf/js/hotspots";
import type { JsCdp } from "@delacour/warden-perf/js/js.types";
import { type ComponentSource, type ReactAnalysis, reactAnalyzer } from "@delacour/warden-perf/react/analyze";
import { type CpuIndex, cpuCorrelator, type FrameLabel } from "@delacour/warden-perf/react/pipeline/cpu-correlate";
import { hotCommits } from "@delacour/warden-perf/react/pipeline/hot-commits";
import { componentReducer } from "@delacour/warden-perf/react/pipeline/reduce";
import { reactProfiler } from "@delacour/warden-perf/react/profiler";
import type { CommitsFile, ReactError, ReactResult } from "@delacour/warden-perf/react/react.types";
import { reactResultFactory } from "@delacour/warden-perf/react/react.types";
import type { Finding } from "@delacour/warden-perf/shared/findings.types";
import type { ReportSection } from "@delacour/warden-perf/shared/render-md";
import type { WardenError } from "@delacour/warden-types/error";
import { opErrors } from "../errors";
import type { PerfEnv } from "./env";
import { CPU_FILE, HOTSPOTS_FILE } from "./js-capture";
import { COMMITS_FILE, FINDINGS_FILE } from "./react-out";
import { defaultSourceDeps, reactSources, type SourceDeps } from "./react-source";

const NAMES_TO_LOCATE = 40;

export type CpuCorrelation = { index: CpuIndex; label: FrameLabel };

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

export type ReactStartResult = { startedWallMs: number; dev: boolean; rn: string | null; bootstrapped: boolean };

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

/** ReactCapture: react capture. */
export class ReactCapture {
	/** A React profiling failure as a `warden perf` error. The runtime's three typed causes keep their code in the message and `details.react`. */
	reactUiError(error: ReactError): WardenError {
		const extra = { ...(error.hint === undefined ? {} : { hint: error.hint }), details: { react: error.code } };
		switch (error.code) {
			case "rn_too_old":
			case "devtools_backend_missing":
				return opErrors.opError("engine_unavailable", `${error.code}: ${error.message}`, extra);
			case "release_build":
				return opErrors.opError("not_profileable", `${error.code}: ${error.message}`, extra);
			case "session_active":
				return opErrors.opError("session_active", error.message, {
					...extra,
					details: { react: error.code, ...(error.owner === undefined ? {} : { owner: error.owner }) },
				});
			default:
				return opErrors.opError("failed", error.message, extra);
		}
	}

	/** Who holds the profile: stable across the `start` and `stop` invocations of one agent or shell, distinct between two. */
	async reactOwner(ctx: PerfEnv): Promise<string> {
		const { ownerResolver } = await import("@delacour/warden-leasing/owner");
		const owner = ownerResolver.resolve(ctx);
		if (owner.kind === "agent") return `agent:${owner.sessionId}`;
		if (owner.kind === "user") return `user:${owner.pid}`;
		return `ci:${owner.runId}`;
	}

	/**
	 * The session's JS profile as a lookup by device wall time, when `js/cpu.cpuprofile` and `js/hotspots.json` (its
	 * clock anchor) are both there. Frames are named from the hotspot table (source-mapped `file:line`) by function
	 * name, else by the script position.
	 */
	loadCpuCorrelation(jsDir: string | undefined): CpuCorrelation | undefined {
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
			return { index: cpuCorrelator.indexProfile(profile, start), label };
		} catch {
			return undefined;
		}
	}

	/** Names worth locating: the costliest components and whatever fills a hot commit. */
	private namesToLocate(file: CommitsFile): string[] {
		const byCost = componentReducer
			.reduceComponents(file.commits)
			.sort((a, b) => b.sumSelfMs - a.sumSelfMs)
			.slice(0, NAMES_TO_LOCATE)
			.map((s) => s.name);
		const hot = hotCommits.find(file.commits).flatMap((h) => h.top.map((t) => t.name));
		return [...new Set([...byCost, ...hot])];
	}

	/**
	 * Analyse a recording and write `react/commits.json` and `react/findings.json`: components located (the runtime's
	 * `_debugSource`, else a grep of the project), hot commits correlated with the session's JS CPU profile when there is
	 * one.
	 */
	analyzeAndWrite(file: CommitsFile, out: ReactOutputs): ReactCaptureResult {
		const located = reactSources.resolveSources(
			this.namesToLocate(file),
			out.cwd,
			file.sources,
			out.sourceDeps ?? defaultSourceDeps
		);
		const cpu = this.loadCpuCorrelation(out.jsDir);
		const analysis = reactAnalyzer.analyzeReact(file, {
			...(out.sessionId === undefined ? {} : { sessionId: out.sessionId }),
			locate: (name): ComponentSource | undefined => located.get(name),
			...(cpu === undefined ? {} : { cpu }),
		});
		mkdirSync(out.dir, { recursive: true });
		const commitsPath = join(out.dir, COMMITS_FILE);
		const findingsPath = join(out.dir, FINDINGS_FILE);
		writeFileSync(commitsPath, JSON.stringify(file));
		writeFileSync(findingsPath, `${JSON.stringify(analysis, null, 2)}\n`);
		return {
			commitsPath,
			findingsPath,
			file,
			analysis,
			findings: analysis.findings,
			section: reactAnalyzer.reactSection(analysis),
		};
	}

	/** Begin React profiling in the app; the profile lives in its runtime until `stopReactCapture`. */
	async startReactCapture(
		cdp: JsCdp,
		options: { owner: string; force?: boolean }
	): Promise<ReactResult<ReactStartResult>> {
		const started = await reactProfiler.startReactProfile(cdp, options);
		if (!started.success) return started;
		const { startedWall, dev, rn, bootstrapped } = started.data;
		return reactResultFactory.ok({ startedWallMs: startedWall, dev, rn, bootstrapped });
	}

	/** End React profiling, then analyse and write (see `analyzeAndWrite`). `hostWallMs` = host clock at start, for alignment. */
	async stopReactCapture(
		cdp: JsCdp,
		options: ReactOutputs & { owner: string; force?: boolean; hostWallMs?: number }
	): Promise<ReactResult<ReactCaptureResult>> {
		const stopped = await reactProfiler.stopReactProfile(cdp, {
			owner: options.owner,
			...(options.force === undefined ? {} : { force: options.force }),
			...(options.hostWallMs === undefined ? {} : { hostWallMs: options.hostWallMs }),
		});
		if (!stopped.success) return stopped;
		try {
			return reactResultFactory.ok(this.analyzeAndWrite(stopped.data, options));
		} catch (error) {
			return reactResultFactory.err(
				"invalid_data",
				`could not write the React report: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	/** Start, wait `durationMs` (or until `signal` aborts), stop and write: the session collector's one call. */
	async runReactCapture(cdp: JsCdp, options: RunReactCaptureOptions): Promise<ReactResult<ReactCaptureResult>> {
		const hostWallMs = (options.now ?? Date.now)();
		const started = await this.startReactCapture(cdp, {
			owner: options.owner,
			...(options.force === undefined ? {} : { force: options.force }),
		});
		if (!started.success) return started;
		options.onStarted?.({ ...started.data, hostWallMs });
		await options.sleep(options.durationMs, options.signal);
		return this.stopReactCapture(cdp, { ...options, hostWallMs });
	}
}

export const reactCapture = new ReactCapture();
