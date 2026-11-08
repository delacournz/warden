import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SAMPLING_INTERVAL_US } from "@delacour/warden-perf/js/cpu-profile";
import type { JsCdp } from "@delacour/warden-perf/js/js.types";
import type { MapFetch } from "@delacour/warden-perf/js/symbolicate";
import { ok } from "@delacour/warden-types/result";
import { z } from "zod";
import { fetchMapCapped, type JsCapture, startJsProfile, stopJsProfile } from "../perf/js-capture";
import { startReactCapture, stopReactCapture } from "../perf/react-capture";
import { type BrokerContext, type BrokerResult, brokerErr } from "./broker.types";
import type { BrokerExtension } from "./extensions";
import type {
	ProfileKind,
	ProfileStartData,
	ProfileStatusData,
	ProfileStopData,
	ProfileSummary,
} from "./profile-client";

/** Rows per summary list. */
export const PROFILE_TOP = 10;

/** The React profile owner the broker registers with the app runtime. */
export const BROKER_REACT_OWNER = "warden-broker";

const kindSchema = z.enum(["cpu", "heap", "react"]);
const startSchema = z.strictObject({
	kind: kindSchema,
	samplingIntervalUs: z.number().int().min(10).optional(),
});
const stopSchema = z.strictObject({ kind: kindSchema });
const statusSchema = z.strictObject({});

/** Side effects the profiles extension reaches through; tests inject fakes. */
export type ProfilesDeps = {
	now: () => number;
	/** where project sources are located for React components, and source maps are shown relative to */
	cwd: string;
	fetchMap: MapFetch;
};

const defaultDeps = (): ProfilesDeps => ({ now: Date.now, cwd: process.cwd(), fetchMap: fetchMapCapped });

type Active =
	| { kind: "cpu"; startedAt: number; capture: JsCapture }
	| { kind: "heap"; startedAt: number }
	| { kind: "react"; startedAt: number; hostWallMs: number };

/** `20261024T101500Z`: sorts by time, safe in a path. */
const stamp = (ms: number): string =>
	new Date(ms)
		.toISOString()
		.replace(/\.\d+Z$/, "Z")
		.replace(/[-:]/g, "");

function cdpErr(message: string, hint?: string) {
	return brokerErr("cdp_protocol", message, hint);
}

type HeapNode = {
	callFrame?: { functionName?: string; url?: string; lineNumber?: number };
	selfSize?: number;
	children?: HeapNode[];
};

/** Allocation sites of a `HeapProfiler.stopSampling` profile by live bytes, largest first. */
export function summarizeHeapSampling(head: HeapNode, top = PROFILE_TOP): Extract<ProfileSummary, { kind: "heap" }> {
	const sites = new Map<string, { name: string; file: string; line: number; selfBytes: number }>();
	let totalBytes = 0;
	const stack: HeapNode[] = [head];
	for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
		const size = node.selfSize ?? 0;
		if (size > 0) {
			const name = node.callFrame?.functionName || "(anonymous)";
			const file = node.callFrame?.url ?? "";
			const line = (node.callFrame?.lineNumber ?? 0) + 1;
			const key = `${name}\0${file}\0${line}`;
			const site = sites.get(key) ?? { name, file, line, selfBytes: 0 };
			site.selfBytes += size;
			sites.set(key, site);
			totalBytes += size;
		}
		stack.push(...(node.children ?? []));
	}
	const topAllocators = [...sites.values()]
		.sort((a, b) => b.selfBytes - a.selfBytes)
		.slice(0, top)
		.map((s) => ({ ...s, pct: totalBytes === 0 ? 0 : Math.round((s.selfBytes / totalBytes) * 1000) / 10 }));
	return { kind: "heap", totalBytes, topAllocators };
}

const heapHeadSchema = z.object({ profile: z.object({ head: z.looseObject({}) }).loose() });

/**
 * `profile.start {kind, samplingIntervalUs?}`, `profile.stop {kind}`, `profile.status`: CPU (Hermes `Profiler`),
 * heap sampling (`HeapProfiler.startSampling`) and React commit profiling, recorded on the broker's own session so
 * `warden perf` and the MCP server never open a second socket (which a single-debugger Metro answers by closing
 * the broker's). Artifacts land in `<logDir>/profiles/<kind>-<ts>/`. A reload loses the recording (Hermes holds it
 * for the socket's page), so the state resets on every attach.
 */
export function createProfilesExtension(overrides: Partial<ProfilesDeps> = {}): BrokerExtension {
	const deps: ProfilesDeps = { ...defaultDeps(), ...overrides };
	return (broker, extension) => {
		const active = new Map<ProfileKind, Active>();
		let release: Array<() => void> = [];
		const forget = () => active.clear();
		const dropOnAttach = broker.onAttach((session) => {
			for (const off of release) off();
			active.clear();
			release = [session.on("reconnected", forget), session.onCdp("Runtime.executionContextsCleared", forget)];
		});

		const dirFor = (kind: ProfileKind): string => join(extension.logDir, "profiles", `${kind}-${stamp(deps.now())}`);

		async function beginCpu(
			cdp: JsCdp,
			intervalUs: number | undefined,
			startedAt: number
		): Promise<BrokerResult<Active>> {
			const capture = await startJsProfile(cdp, {
				samplingIntervalUs: intervalUs ?? DEFAULT_SAMPLING_INTERVAL_US,
				now: deps.now,
			});
			if (!capture.success) return cdpErr(capture.error.message, capture.error.hint);
			return ok({ kind: "cpu", startedAt, capture: capture.data });
		}

		async function beginHeap(cdp: JsCdp, startedAt: number): Promise<BrokerResult<Active>> {
			const started = await cdp.send("HeapProfiler.startSampling", {});
			if (started.success) return ok({ kind: "heap", startedAt });
			return cdpErr(
				`HeapProfiler.startSampling: ${started.error.message}`,
				"needs Hermes with the HeapProfiler domain"
			);
		}

		async function beginReact(cdp: JsCdp, startedAt: number): Promise<BrokerResult<Active>> {
			const started = await startReactCapture(cdp, { owner: BROKER_REACT_OWNER, force: true });
			if (!started.success) return cdpErr(`${started.error.code}: ${started.error.message}`, started.error.hint);
			return ok({ kind: "react", startedAt, hostWallMs: startedAt });
		}

		function begin(
			kind: ProfileKind,
			cdp: JsCdp,
			intervalUs: number | undefined,
			startedAt: number
		): Promise<BrokerResult<Active>> {
			if (kind === "cpu") return beginCpu(cdp, intervalUs, startedAt);
			return kind === "heap" ? beginHeap(cdp, startedAt) : beginReact(cdp, startedAt);
		}

		async function start(params: unknown, context: BrokerContext): Promise<BrokerResult<ProfileStartData>> {
			const parsed = startSchema.safeParse(params);
			if (!parsed.success) return brokerErr("bad_request", `profile.start: ${parsed.error.message}`);
			const { kind, samplingIntervalUs } = parsed.data;
			const session = context.requireSession();
			if (!session.success) return session;
			if (active.has(kind)) {
				return brokerErr("bad_request", `a ${kind} profile is already recording`, "run profile.stop first");
			}
			const startedAt = deps.now();
			const recording = await begin(kind, session.data, samplingIntervalUs, startedAt);
			if (!recording.success) return recording;
			active.set(kind, recording.data);
			return ok({ kind, startedAt });
		}

		async function stopCpu(
			cdp: JsCdp,
			recording: Extract<Active, { kind: "cpu" }>,
			dir: string
		): Promise<BrokerResult<ProfileStopData>> {
			const stopped = await stopJsProfile(
				{ ...recording.capture, cdp },
				{ dir, metroUrl: extension.metroUrl, fetchMap: deps.fetchMap, projectRoot: deps.cwd }
			);
			if (!stopped.success) return cdpErr(stopped.error.message, stopped.error.hint);
			const h = stopped.data.hotspots;
			return ok({
				kind: "cpu",
				path: stopped.data.cpuPath,
				summary: {
					kind: "cpu",
					sampleCount: h.sampleCount,
					durationMs: h.durationMs,
					idlePct: h.idlePct,
					hotspotsPath: stopped.data.hotspotsPath,
					topSelf: h.topSelf.slice(0, PROFILE_TOP).map((f) => ({
						name: f.name,
						file: f.file,
						line: f.line,
						selfMs: f.selfMs,
						selfPct: f.selfPct,
					})),
				},
			});
		}

		async function stopHeap(cdp: JsCdp, dir: string): Promise<BrokerResult<ProfileStopData>> {
			const stopped = await cdp.send("HeapProfiler.stopSampling", {}, { timeoutMs: 60_000 });
			if (!stopped.success) {
				return cdpErr(
					`HeapProfiler.stopSampling: ${stopped.error.message}`,
					"the app may have reloaded during the capture; start again"
				);
			}
			const parsed = heapHeadSchema.safeParse(stopped.data);
			if (!parsed.success) return cdpErr("HeapProfiler.stopSampling returned no sampling profile");
			mkdirSync(dir, { recursive: true });
			const path = join(dir, "heap.heapsampling");
			writeFileSync(path, JSON.stringify(parsed.data.profile));
			return ok({ kind: "heap", path, summary: summarizeHeapSampling(parsed.data.profile.head) });
		}

		async function stopReact(
			cdp: JsCdp,
			recording: Extract<Active, { kind: "react" }>,
			dir: string
		): Promise<BrokerResult<ProfileStopData>> {
			const stopped = await stopReactCapture(cdp, {
				dir,
				cwd: deps.cwd,
				owner: BROKER_REACT_OWNER,
				force: true,
				hostWallMs: recording.hostWallMs,
			});
			if (!stopped.success) return cdpErr(`${stopped.error.code}: ${stopped.error.message}`, stopped.error.hint);
			const { analysis } = stopped.data;
			return ok({
				kind: "react",
				path: stopped.data.commitsPath,
				summary: {
					kind: "react",
					commits: analysis.totals.commits,
					renderMs: analysis.totals.renderMs,
					hotCommits: analysis.totals.hot,
					findingsPath: stopped.data.findingsPath,
					slowestCommits: [...analysis.hotCommits]
						.sort((a, b) => b.durationMs - a.durationMs)
						.slice(0, PROFILE_TOP)
						.map((c) => ({ index: c.index, durationMs: c.durationMs, tier: c.tier, top: c.top.map((t) => t.name) })),
					slowestComponents: [...analysis.components]
						.sort((a, b) => b.sumSelfMs - a.sumSelfMs)
						.slice(0, PROFILE_TOP)
						.map((c) => ({
							name: c.name,
							sumSelfMs: c.sumSelfMs,
							commits: c.commits,
							...(c.source === undefined ? {} : { where: `${c.source.file}:${c.source.line}` }),
						})),
				},
			});
		}

		async function finish(recording: Active, session: JsCdp): Promise<BrokerResult<ProfileStopData>> {
			const dir = dirFor(recording.kind);
			try {
				if (recording.kind === "cpu") return await stopCpu(session, recording, dir);
				if (recording.kind === "heap") return await stopHeap(session, dir);
				return await stopReact(session, recording, dir);
			} catch (error) {
				return brokerErr("io_failed", `could not write the ${recording.kind} profile: ${String(error)}`);
			}
		}

		async function stop(params: unknown, context: BrokerContext): Promise<BrokerResult<ProfileStopData>> {
			const parsed = stopSchema.safeParse(params);
			if (!parsed.success) return brokerErr("bad_request", `profile.stop: ${parsed.error.message}`);
			const { kind } = parsed.data;
			const recording = active.get(kind);
			if (recording === undefined) {
				return brokerErr("bad_request", `no ${kind} profile is recording`, "run profile.start first");
			}
			const session = context.requireSession();
			if (!session.success) return session;
			active.delete(kind);
			return finish(recording, session.data);
		}

		const methods: Array<[string, (p: unknown, c: BrokerContext) => Promise<BrokerResult<unknown>>]> = [
			["profile.start", start],
			["profile.stop", stop],
			[
				"profile.status",
				async (params) => {
					const parsed = statusSchema.safeParse(params ?? {});
					if (!parsed.success) return brokerErr("bad_request", `profile.status: ${parsed.error.message}`);
					const data: ProfileStatusData = {
						active: [...active.values()].map((a) => ({ kind: a.kind, startedAt: a.startedAt })),
					};
					return ok(data);
				},
			],
		];
		const removers: Array<() => void> = [];
		for (const [name, handler] of methods) {
			const registered = broker.registerMethod(name, handler);
			if (registered.success) removers.push(registered.data);
			else extension.log(`profiles: ${registered.error.message}`);
		}
		return () => {
			for (const remove of removers) remove();
			dropOnAttach();
			for (const off of release) off();
			active.clear();
		};
	};
}

export const profilesExtension: BrokerExtension = createProfilesExtension();
