import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { MAX_TEXT_LINES } from "@delacour/warden-perf/shared/caps";
import type { Finding } from "@delacour/warden-perf/shared/findings.types";
import { renderMarkdown, SIMULATOR_BANNER } from "@delacour/warden-perf/shared/render-md";
import { formatSessionId } from "@delacour/warden-perf/shared/session.schema";
import { type StartupMethod, slowStartupFinding } from "@delacour/warden-perf/startup/findings";
import { type StartupStats, summarize } from "@delacour/warden-perf/startup/stats";
import type { Platform } from "@delacour/warden-store/types";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { writeFileAtomic } from "./device-state";
import type { PerfEnv } from "./env";
import { perfRoot } from "./paths";
import { defaultRelaunchIo } from "./relaunch";
import { activeSessionFor, sessionDir } from "./session";
import {
	type MeasureCtx,
	type MeasureIo,
	measureAndroid,
	measureIosApprox,
	measureIosXctrace,
	type StartupKind,
	type StartupRun,
} from "./startup-measure";
import type { PerfEngineDeps, PerfOutcome, PerfTarget } from "./types";

export const DEFAULT_RUNS = 5;
export const MAX_RUNS = 20;
const MARK_POLLS = 6;
const MARK_POLL_MS = 500;

export type { StartupKind, StartupRun };

export type StartupMark = { name: string; startTimeMs: number };

/** Host effects of `perf startup` beyond `PerfEngineDeps`; tests inject fakes. */
export type StartupIo = MeasureIo & {
	/** `performance.getEntriesByType('mark')` of the app's JS runtime through Metro, polling while the new target appears */
	readMarks: (
		metroUrl: string,
		appId: string,
		deviceName: string | undefined
	) => Promise<Result<StartupMark[], string>>;
};

const MARKS_EXPRESSION =
	"JSON.stringify((globalThis.performance?.getEntriesByType?.('mark') ?? []).map(function(m){return {name:m.name,startTime:m.startTime}}))";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function toMarks(json: string): StartupMark[] {
	const parsed: unknown = JSON.parse(json);
	return (Array.isArray(parsed) ? parsed : []).flatMap((m: { name?: unknown; startTime?: unknown }) =>
		typeof m.name === "string" && typeof m.startTime === "number"
			? [{ name: m.name, startTimeMs: Math.round(m.startTime) }]
			: []
	);
}

export const defaultStartupIo: StartupIo = {
	...defaultRelaunchIo,
	sleep,
	readMarks: async (metroUrl, appId, deviceName) => {
		const { devtoolsConnector } = await import("@delacour/warden-devtools/session");
		let lastError = "no devtools target";
		for (let i = 0; i < MARK_POLLS; i++) {
			const session = await devtoolsConnector.connect({
				metroUrl,
				device: { appId, ...(deviceName !== undefined ? { deviceName } : {}) },
				fetch: (url, init) => fetch(url, init),
				reconnectBudgetMs: 1_000,
			});
			if (!session.success) {
				lastError = session.error.message;
				await sleep(MARK_POLL_MS);
				continue;
			}
			try {
				const out = await session.data.evaluate(MARKS_EXPRESSION);
				return out.success ? resultFactory.ok(toMarks(String(out.data))) : { success: false, error: out.error.message };
			} finally {
				session.data.close();
			}
		}
		return { success: false, error: lastError };
	},
};

type MarksOutcome = { marks: StartupMark[]; note?: string };

/** RN layer: the app's `performance` marks through Metro. Never fails the command: a missing Metro or target is a note. */
async function collectMarks(
	ctx: PerfEnv,
	deps: PerfEngineDeps,
	io: StartupIo,
	udid: string,
	appId: string,
	deviceName: string | undefined
): Promise<MarksOutcome> {
	const metroUrl = await deps.host.metro(ctx, udid).catch(() => undefined);
	if (metroUrl === undefined) return { marks: [], note: "no Metro for this device: RN marks skipped" };
	const read = await io
		.readMarks(metroUrl, appId, deviceName)
		.catch((e: unknown) => ({ success: false as const, error: String(e) }));
	return read.success ? { marks: read.data } : { marks: [], note: `RN marks skipped: ${read.error}` };
}

function outDirFor(ctx: PerfEnv, deps: PerfEngineDeps, udid: string): string {
	const session = activeSessionFor(ctx, deps.session, udid);
	const dir =
		session === undefined
			? join(perfRoot(ctx), formatSessionId(ctx.now(), deps.session.random()))
			: sessionDir(ctx, session.id);
	mkdirSync(join(dir, "metrics"), { recursive: true });
	return dir;
}

type KindSummary = Partial<Record<StartupKind, StartupStats>>;

function summaryLines(method: StartupMethod, runs: readonly StartupRun[], by: KindSummary): string[] {
	const lines: string[] = [];
	for (const kind of ["cold", "warm"] as const) {
		const s = by[kind];
		if (s === undefined) continue;
		lines.push(
			`${kind}  median ${s.medianMs}ms  p90 ${s.p90Ms}ms  min ${s.minMs}ms  max ${s.maxMs}ms  (${s.runs} runs, ${method})`
		);
	}
	const drawn = runs.flatMap((r) => (r.fullyDrawnMs === undefined ? [] : [r.fullyDrawnMs]));
	const fully = summarize(drawn);
	if (fully !== undefined)
		lines.push(`fully drawn (reportFullyDrawn)  median ${fully.medianMs}ms  max ${fully.maxMs}ms`);
	else if (runs.some((r) => r.launchState !== undefined))
		lines.push("fully drawn: not reported (call reportFullyDrawn() when the first screen is usable)");
	return lines;
}

function measure(platform: Platform, method: StartupMethod, c: MeasureCtx) {
	if (platform === "android") return measureAndroid(c);
	return method === "xctrace" ? measureIosXctrace(c) : measureIosApprox(c);
}

function statsByKind(runs: readonly StartupRun[], kinds: readonly StartupKind[]): KindSummary {
	const by: KindSummary = {};
	for (const kind of kinds) {
		const stats = summarize(runs.filter((r) => r.kind === kind).map((r) => r.totalMs));
		if (stats !== undefined) by[kind] = stats;
	}
	return by;
}

/** The shape of a startup run: how many launches of which kinds, timed by which method. */
export type StartupPlan = { count: number; method: StartupMethod; kinds: StartupKind[] };

/** The `result` of `perf startup --json`. */
export type StartupResult = {
	version: 1;
	method: StartupMethod;
	appId: string;
	device: { udid: string; platform: Platform; name: string | undefined };
	startedAt: number;
	runs: StartupRun[];
	summary: Partial<Record<StartupKind, StartupStats>>;
	marks: StartupMark[];
	notes: string[];
	findings: Finding[];
	path: string;
};

/**
 * Cold / warm app start time on a resolved device and app: kills and relaunches the app (a mutation: the caller holds
 * the lease), over `plan.count` launches per kind. Writes `metrics/startup.json` into the running session, else a
 * one-shot dir.
 */
export async function startupWork(
	ctx: PerfEnv,
	deps: PerfEngineDeps,
	target: PerfTarget,
	appId: string,
	plan: StartupPlan,
	io: StartupIo = defaultStartupIo
): PerfOutcome<StartupResult> {
	const outDir = outDirFor(ctx, deps, target.udid);
	const device = { platform: target.platform, id: target.udid };
	const measured = await measure(target.platform, plan.method, {
		ctx,
		device,
		appId,
		kinds: plan.kinds,
		count: plan.count,
		io,
		outDir,
	});
	if (!measured.success) return measured;
	const { runs, notes } = measured.data;
	const marks = await collectMarks(ctx, deps, io, target.udid, appId, target.name);
	if (marks.note !== undefined) notes.push(marks.note);
	const by = statsByKind(runs, plan.kinds);
	const finding = slowStartupFinding(plan.method, by.cold, marks.marks.length > 0 || marks.note === undefined);
	const findings: Finding[] = finding === undefined ? [] : [finding];
	const file = join(outDir, "metrics", "startup.json");
	const info = { udid: target.udid, platform: target.platform, name: target.name };
	const doc = {
		version: 1 as const,
		method: plan.method,
		appId,
		device: info,
		startedAt: ctx.now(),
		runs,
		summary: by,
		marks: marks.marks,
		notes,
		findings,
	};
	writeFileAtomic(file, `${JSON.stringify(doc, null, 2)}\n`);
	const markLines = marks.marks.slice(0, 8).map((m) => `${m.name}  +${m.startTimeMs}ms`);
	const text = renderMarkdown(
		{
			title: `perf startup ${appId}`,
			banners: [SIMULATOR_BANNER],
			summary: [...summaryLines(plan.method, runs, by), ...notes.map((n) => `note: ${n}`), `saved: ${file}`],
			findings,
			sections: markLines.length > 0 ? [{ title: "RN marks", lines: markLines }] : [],
			next: [
				"warden perf record --relaunch --js",
				"warden perf startup --warm",
				`warden perf startup --runs ${Math.min(MAX_RUNS, plan.count * 2)}`,
			],
		},
		{ maxLines: MAX_TEXT_LINES }
	);
	return resultFactory.ok({ device: info, result: { ...doc, path: file }, text });
}
