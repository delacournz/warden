import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Command as Commander } from "@commander-js/extra-typings";
import type { Platform } from "@delacour/warden-core/types";
import { MAX_TEXT_LINES } from "@delacour/warden-perf/shared/caps";
import type { Finding } from "@delacour/warden-perf/shared/findings.types";
import { renderMarkdown, SIMULATOR_BANNER } from "@delacour/warden-perf/shared/render-md";
import { formatSessionId } from "@delacour/warden-perf/shared/session.schema";
import { type StartupMethod, slowStartupFinding } from "@delacour/warden-perf/startup/findings";
import { type StartupStats, summarize } from "@delacour/warden-perf/startup/stats";
import { ok, type Result } from "@delacour/warden-types/result";
import { type UiError, uiError } from "../agent-ui/output";
import { writeFileAtomic } from "../agent-ui/state";
import type { CommandContext } from "../context";
import { resolveApp } from "./app";
import { withPerfOptions } from "./options";
import { perfRoot } from "./paths";
import { defaultRelaunchIo } from "./relaunch";
import { type PerfDeps, type PerfOptionValues, runPerf } from "./run";
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

export const DEFAULT_RUNS = 5;
export const MAX_RUNS = 20;
const MARK_POLLS = 6;
const MARK_POLL_MS = 500;

export type { StartupKind, StartupRun };

export type StartupMark = { name: string; startTimeMs: number };

export type StartupOptions = PerfOptionValues & { cold?: true; warm?: true; runs?: string; method?: string };

/** Host effects of `perf startup` beyond `PerfDeps`; tests inject fakes. */
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
		const { connectDevtools } = await import("@delacour/warden-e2e/devtools/session");
		let lastError = "no devtools target";
		for (let i = 0; i < MARK_POLLS; i++) {
			const session = await connectDevtools({
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
				return out.success ? ok(toMarks(String(out.data))) : { success: false, error: out.error.message };
			} finally {
				session.data.close();
			}
		}
		return { success: false, error: lastError };
	},
};

const fail = (error: UiError): { success: false; error: UiError } => ({ success: false, error });

function parseRuns(raw: string | undefined): Result<number, UiError> {
	if (raw === undefined) return ok(DEFAULT_RUNS);
	if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_RUNS) {
		return fail(uiError("usage", `--runs must be an integer 1-${MAX_RUNS}, got "${raw}"`));
	}
	return ok(Number(raw));
}

type IosMethod = "approx" | "xctrace";

function parseMethod(raw: string | undefined, platform: Platform): Result<StartupMethod, UiError> {
	if (platform === "android") {
		return raw === undefined || raw === "am-start"
			? ok("am-start")
			: fail(uiError("usage", `--method ${raw} is iOS only (Android always uses am start -W)`));
	}
	const method: IosMethod | undefined =
		raw === undefined || raw === "approx" ? "approx" : raw === "xctrace" ? "xctrace" : undefined;
	if (method === undefined) return fail(uiError("usage", `--method must be approx or xctrace, got "${raw}"`));
	return ok(method === "approx" ? "simctl-approx" : "xctrace");
}

type MarksOutcome = { marks: StartupMark[]; note?: string };

/** RN layer: the app's `performance` marks through Metro. Never fails the command: a missing Metro or target is a note. */
async function collectMarks(
	ctx: CommandContext,
	deps: PerfDeps,
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

function outDirFor(ctx: CommandContext, deps: PerfDeps, udid: string): string {
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

type Plan = { count: number; method: StartupMethod; kinds: StartupKind[] };

/** `--runs`, `--method` (per platform) and `--cold|--warm` (default cold) as a plan, or a usage error. */
function planOf(opts: StartupOptions, platform: Platform): Result<Plan, UiError> {
	const count = parseRuns(opts.runs);
	if (!count.success) return count;
	const method = parseMethod(opts.method, platform);
	if (!method.success) return method;
	const kinds: StartupKind[] = [];
	if (opts.cold === true || opts.warm !== true) kinds.push("cold");
	if (opts.warm === true) kinds.push("warm");
	return ok({ count: count.data, method: method.data, kinds });
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

/** `warden perf startup`: cold/warm app start time, median and p90 over `--runs`. Mutates the app, so it needs the caller's lease (`--claim`). */
export function perfStartup(
	ctx: CommandContext,
	deps: PerfDeps,
	opts: StartupOptions,
	io: StartupIo = defaultStartupIo
): Promise<number> {
	return runPerf(ctx, deps, "startup", "mutate", opts, async (target) => {
		const plan = planOf(opts, target.platform);
		if (!plan.success) return plan;
		const app = await resolveApp(ctx, { platform: target.platform, id: target.udid }, opts.app);
		if (!app.success) return app;
		const outDir = outDirFor(ctx, deps, target.udid);
		const device = { platform: target.platform, id: target.udid };
		const measured = await measure(target.platform, plan.data.method, {
			ctx,
			device,
			appId: app.data.id,
			kinds: plan.data.kinds,
			count: plan.data.count,
			io,
			outDir,
		});
		if (!measured.success) return measured;
		const { runs, notes } = measured.data;
		const marks = await collectMarks(ctx, deps, io, target.udid, app.data.id, target.name);
		if (marks.note !== undefined) notes.push(marks.note);
		const by = statsByKind(runs, plan.data.kinds);
		const finding = slowStartupFinding(plan.data.method, by.cold, marks.marks.length > 0 || marks.note === undefined);
		const findings: Finding[] = finding === undefined ? [] : [finding];
		const file = join(outDir, "metrics", "startup.json");
		const info = { udid: target.udid, platform: target.platform, name: target.name };
		const doc = {
			version: 1,
			method: plan.data.method,
			appId: app.data.id,
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
				title: `perf startup ${app.data.id}`,
				banners: [SIMULATOR_BANNER],
				summary: [...summaryLines(plan.data.method, runs, by), ...notes.map((n) => `note: ${n}`), `saved: ${file}`],
				findings,
				sections: markLines.length > 0 ? [{ title: "RN marks", lines: markLines }] : [],
				next: [
					"warden perf record --relaunch --js",
					"warden perf startup --warm",
					`warden perf startup --runs ${Math.min(MAX_RUNS, plan.data.count * 2)}`,
				],
			},
			{ maxLines: MAX_TEXT_LINES }
		);
		return ok({ device: info, result: { ...doc, path: file }, text });
	});
}

/** Wire `startup` onto `warden perf`. */
export function registerStartup(
	cmd: Commander,
	ctx: CommandContext,
	done: (code: number) => void,
	deps: PerfDeps
): void {
	withPerfOptions(
		cmd
			.command("startup")
			.description(
				"cold/warm app start time: median and p90 over --runs (kills and relaunches the app: needs your lease or --claim)"
			)
			.option("--cold", "force-stop the app before each start (default)")
			.option("--warm", "send the app to the background (HOME) before each start")
			.option("--runs <n>", `launches to time, 1-${MAX_RUNS} (default ${DEFAULT_RUNS})`)
			.option(
				"--method <m>",
				"iOS: approx (simctl launch wall time, default) | xctrace (App Launch template, cold only)"
			)
	).action(async (opts) => {
		done(await perfStartup(ctx, deps, opts));
	});
}
