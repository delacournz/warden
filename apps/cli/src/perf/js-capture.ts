import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DevtoolsResult } from "@delacour/warden-e2e/devtools/devtools.types";
import {
	type CpuProfile,
	DEFAULT_SAMPLING_INTERVAL_US,
	type ProfileStart,
	startProfile,
	stopProfile,
} from "@delacour/warden-perf/js/cpu-profile";
import { analyzeProfile, type Hotspots, hotspotFindings, hotspotsSection } from "@delacour/warden-perf/js/hotspots";
import { type JsCdp, type JsError, type JsResult, jsErr, jsOk, readDevFlag } from "@delacour/warden-perf/js/js.types";
import {
	collectScripts,
	loadSourceMaps,
	MAX_SOURCE_MAP_BYTES,
	type MapFetch,
	type ScriptCollector,
} from "@delacour/warden-perf/js/symbolicate";
import type { Finding } from "@delacour/warden-perf/shared/findings.types";
import type { ReportSection } from "@delacour/warden-perf/shared/render-md";
import { type UiError, uiError } from "../agent-ui/output";

export const JS_DIR = "js";
export const CPU_FILE = "cpu.cpuprofile";
export const HOTSPOTS_FILE = "hotspots.json";

const MAP_FETCH_TIMEOUT_MS = 30_000;

/** The slice of a devtools session the JS capturers use, plus `close`. */
export type JsSession = JsCdp & { close: () => void };

/** What the JS capturers reach the outside world through; tests inject fakes. */
export type JsDeps = {
	/** attach to the app's Hermes runtime through Metro (default: `connectDevtools` over the global `fetch` / `WebSocket`) */
	open: (o: {
		metroUrl: string;
		appId: string | undefined;
		deviceName: string | undefined;
		timeoutMs: number;
	}) => Promise<DevtoolsResult<JsSession>>;
	/** fetch a source map from Metro, refusing past the byte cap */
	fetchMap: MapFetch;
	/** resolves after `ms`, or early when `signal` aborts */
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/** Read a response body, aborting the moment it passes `maxBytes`. */
async function readCapped(res: Response, maxBytes: number): Promise<JsResult<string>> {
	const tooBig = () => jsErr("too_large", `source map is over ${maxBytes / 1024 / 1024}MiB`);
	const declared = Number(res.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) return tooBig();
	const reader = res.body?.getReader();
	if (reader === undefined) return jsOk("");
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxBytes) {
			await reader.cancel();
			return tooBig();
		}
		chunks.push(value);
	}
	return jsOk(Buffer.concat(chunks).toString("utf8"));
}

/** `fetch` with no redirects (a redirect could leave Metro's host), a timeout and a byte cap. */
export const fetchMapCapped: MapFetch = async (url, maxBytes) => {
	try {
		const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(MAP_FETCH_TIMEOUT_MS) });
		if (!res.ok) return jsErr("cdp_failed", `${url} answered ${res.status}`);
		return await readCapped(res, maxBytes);
	} catch (error) {
		return jsErr("cdp_failed", `${url}: ${error instanceof Error ? error.message : String(error)}`);
	}
};

const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});

export const defaultJsDeps: JsDeps = {
	open: async (o) => {
		const { connectDevtools } = await import("@delacour/warden-e2e/devtools/session");
		return connectDevtools({
			metroUrl: o.metroUrl,
			device: {
				...(o.appId === undefined ? {} : { appId: o.appId }),
				...(o.deviceName === undefined ? {} : { deviceName: o.deviceName }),
			},
			fetch,
			WebSocket,
			timeoutMs: o.timeoutMs,
		});
	},
	fetchMap: fetchMapCapped,
	sleep: abortableSleep,
};

/** A JS profiling failure as a `warden perf` error: a runtime without the method is `engine_unavailable` (exit 3). */
export function jsUiError(error: JsError): UiError {
	const extra = { ...(error.hint === undefined ? {} : { hint: error.hint }), details: { js: error.code } };
	if (error.code === "unsupported") return uiError("engine_unavailable", `unsupported: ${error.message}`, extra);
	return uiError("failed", error.message, extra);
}

/** A devtools failure (no Metro target, socket) as a `warden perf` error: no dev client is exit 3. */
export function devtoolsPerfError(error: { code: string; message: string }): UiError {
	const unreachable = error.code === "devtools_unavailable" || error.code === "device_mismatch";
	return unreachable
		? uiError("devtools_unavailable", error.message, {
				hint: "start the dev client with `warden ui open <bundle> --metro <url>`",
				details: { devtools: error.code },
			})
		: uiError("failed", `${error.code}: ${error.message}`, { details: { devtools: error.code } });
}

/** The running capture: hold it between `startJsProfile` and `stopJsProfile`. */
export type JsCapture = {
	cdp: JsCdp;
	scripts: ScriptCollector;
	start: ProfileStart;
	/** host `Date.now()` at `Profiler.start`; with `start.deviceWallMs` it aligns the profile with other capturers */
	hostWallMs: number;
	/** `__DEV__` of the app, when it could be read */
	dev: boolean | undefined;
};

/**
 * Begin a Hermes CPU profile: collect `Debugger.scriptParsed` (the source-map locations), `Profiler.start` at
 * `samplingIntervalUs`, and note the device clock against the host clock. The profiler lives only as long as
 * `cdp`'s socket: whoever calls this keeps the session open until `stopJsProfile`.
 */
export async function startJsProfile(
	cdp: JsCdp,
	options: { samplingIntervalUs?: number; now?: () => number } = {}
): Promise<JsResult<JsCapture>> {
	const scripts = await collectScripts(cdp);
	const dev = await readDevFlag(cdp);
	const hostWallMs = (options.now ?? Date.now)();
	const started = await startProfile(cdp, { samplingIntervalUs: options.samplingIntervalUs });
	if (!started.success) {
		scripts.dispose();
		return started;
	}
	return jsOk({ cdp, scripts, start: started.data, hostWallMs, dev });
}

export type JsOutputs = {
	/** `<session>/js` */
	dir: string;
	metroUrl: string | undefined;
	fetchMap: MapFetch;
	/** original paths are shown relative to this (the app repo) */
	projectRoot?: string;
};

export type JsProfileResult = {
	cpuPath: string;
	hotspotsPath: string;
	hotspots: Hotspots;
	findings: Finding[];
	section: ReportSection;
};

function frames(profile: CpuProfile) {
	return profile.nodes.map((node) => node.callFrame);
}

/**
 * End the profile: `Profiler.stop`, write `js/cpu.cpuprofile` (valid Chrome `.cpuprofile`), map every frame
 * through the app's source maps, and write `js/hotspots.json`.
 */
export async function stopJsProfile(capture: JsCapture, out: JsOutputs): Promise<JsResult<JsProfileResult>> {
	const stopped = await stopProfile(capture.cdp);
	capture.scripts.dispose();
	if (!stopped.success) return stopped;
	const profile = stopped.data;
	mkdirSync(out.dir, { recursive: true });
	const cpuPath = join(out.dir, CPU_FILE);
	writeFileSync(cpuPath, JSON.stringify(profile));
	const maps = await loadSourceMaps(frames(profile), capture.scripts.scripts, {
		metroUrl: out.metroUrl,
		fetchMap: out.fetchMap,
		...(out.projectRoot === undefined ? {} : { projectRoot: out.projectRoot }),
	});
	const hotspots = analyzeProfile(profile, maps.resolve, {
		samplingIntervalUs: capture.start.samplingIntervalUs,
		...(capture.dev === undefined ? {} : { dev: capture.dev }),
		warnings: maps.warnings,
		anchor: { hostWallMs: capture.hostWallMs, deviceWallMs: capture.start.deviceWallMs },
	});
	const hotspotsPath = join(out.dir, HOTSPOTS_FILE);
	writeFileSync(hotspotsPath, `${JSON.stringify(hotspots, null, 2)}\n`);
	return jsOk({
		cpuPath,
		hotspotsPath,
		hotspots,
		findings: hotspotFindings(hotspots),
		section: hotspotsSection(hotspots),
	});
}

export type RunJsCaptureOptions = JsOutputs & {
	durationMs: number;
	samplingIntervalUs?: number;
	/** stops the capture early (SIGTERM / `perf stop` in the collector); the profile so far is still written */
	signal?: AbortSignal;
	sleep: JsDeps["sleep"];
	now?: () => number;
	/** called once the profiler runs, with the alignment anchor (the collector records it in `session.json`) */
	onStarted?: (capture: JsCapture) => void;
};

/**
 * Start, wait `durationMs` (or until `signal` aborts), stop and write. This is what the session collector calls:
 * Hermes profiles only while the inspector socket that started it stays open, so a CLI that exits between
 * `perf start` and `perf stop` cannot hold it; the long-running `perf-collect` process holds `cdp` for the whole
 * capture and `stop` signals it.
 */
export async function runJsCapture(cdp: JsCdp, options: RunJsCaptureOptions): Promise<JsResult<JsProfileResult>> {
	const started = await startJsProfile(cdp, {
		samplingIntervalUs: options.samplingIntervalUs ?? DEFAULT_SAMPLING_INTERVAL_US,
		...(options.now === undefined ? {} : { now: options.now }),
	});
	if (!started.success) return started;
	options.onStarted?.(started.data);
	await options.sleep(options.durationMs, options.signal);
	return stopJsProfile(started.data, options);
}

export { MAX_SOURCE_MAP_BYTES };
