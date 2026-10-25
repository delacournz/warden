import type { Platform } from "@delacour/warden-core/types";
import type { Driver, Point } from "@delacour/warden-e2e/driver/driver.types";
import { openDriver } from "@delacour/warden-e2e/driver/open";
import { DEFAULT_SETTLE_TIMEOUT_MS } from "@delacour/warden-e2e/driver/settle";
import { ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import type { UiDevice } from "./device";
import { defaultDevtoolsDeps, devtoolsUiError, withFacet } from "./devtools-cli";
import { driverUiError, type UiDeps } from "./driver";
import { socketPathFor, stopHelper } from "./helper";
import type { UiError, UiSuccess } from "./output";
import { runUi, type UiOptionValues, type UiRunEnv } from "./run";
import { takeSnapshot } from "./snapshot";
import { positiveInt } from "./snapshot-command";
import { readState } from "./state";

/** The metrics `warden ui bench` measures; names are the plan's ("Speed targets"). */
export type BenchMetricName =
	| "helperColdToSnapshot"
	| "snapshotWarm"
	| "pressHid"
	| "pressSettle"
	| "tree"
	| "openDriver";

/** Print order of the table. */
export const BENCH_METRICS: readonly BenchMetricName[] = [
	"helperColdToSnapshot",
	"snapshotWarm",
	"pressHid",
	"pressSettle",
	"tree",
	"openDriver",
];

/** A metric's target in ms: the p50 bound, plus an optional p95 bound. */
export type BenchTarget = { p50Ms: number; p95Ms?: number };

/** A measurement passes up to target × this (the plan's tolerance for loaded machines). */
export const BENCH_TOLERANCE = 1.5;

/**
 * The speed targets of `docs/plans/wdn-e2e.md`, per platform. A metric missing for a platform is not
 * measured there (Android: warm snapshot and HID tap only).
 */
export const BENCH_TARGETS: Readonly<Record<Platform, Partial<Record<BenchMetricName, BenchTarget>>>> = {
	ios: {
		helperColdToSnapshot: { p50Ms: 1500 },
		snapshotWarm: { p50Ms: 60, p95Ms: 120 },
		pressHid: { p50Ms: 30 },
		pressSettle: { p50Ms: 600 },
		tree: { p50Ms: 250 },
		openDriver: { p50Ms: 500 },
	},
	android: {
		snapshotWarm: { p50Ms: 800 },
		pressHid: { p50Ms: 120 },
	},
};

/** Samples taken by default (`--runs`). */
export const DEFAULT_BENCH_RUNS = 20;

/** Slow metrics never take more samples than this, whatever `--runs` says. */
const SAMPLE_CAPS: Partial<Record<BenchMetricName, number>> = {
	helperColdToSnapshot: 3,
	pressSettle: 5,
	openDriver: 5,
};

export type BenchSkipReason = "devtools_unavailable";

/** One metric: measured (percentiles in ms) or skipped. `ok` is set when a target exists and the tolerance covers it. */
export type BenchMetric =
	| { skipped: BenchSkipReason; samples: 0; detail?: string; targetMs?: number }
	| { p50: number; p95: number; samples: number; targetMs?: number; targetP95Ms?: number; ok?: boolean };

export type BenchResult = Partial<Record<BenchMetricName, BenchMetric>>;

/** Everything impure about the bench; tests replace the clock and the helper/driver plumbing. */
export type BenchDeps = {
	/** monotonic milliseconds (default `performance.now`) */
	clock?: () => number;
	/** stop the device's helper so the next connect is cold (default: `stopHelper`) */
	stopHelper?: (ctx: CommandContext, udid: string) => Promise<unknown>;
	/** a second driver client on the resident helper socket (default: `openDriver` with `WARDEN_SIMD_SOCKET`) */
	openSecond?: (ctx: CommandContext, device: UiDevice, socketPath: string) => Promise<Result<Driver, UiError>>;
};

export type BenchOptionValues = UiOptionValues & { runs?: string; metro?: string };

/** Nearest-rank percentile of an ascending list (`q` in 0..1). */
export function percentile(sorted: readonly number[], q: number): number {
	if (sorted.length === 0) return Number.NaN;
	const rank = Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length)));
	return sorted[rank - 1] ?? Number.NaN;
}

const round1 = (ms: number) => Math.round(ms * 10) / 10;

/** Does the measurement stay within target × tolerance (p50, and p95 when the target has one)? */
export function withinTolerance(p50: number, p95: number, target: BenchTarget): boolean {
	if (p50 > target.p50Ms * BENCH_TOLERANCE) return false;
	return target.p95Ms === undefined || p95 <= target.p95Ms * BENCH_TOLERANCE;
}

/** Percentiles of `samples` (ms), judged against `target` when there is one. */
export function summarize(samples: readonly number[], target: BenchTarget | undefined): BenchMetric {
	const sorted = [...samples].sort((a, b) => a - b);
	const p50 = round1(percentile(sorted, 0.5));
	const p95 = round1(percentile(sorted, 0.95));
	return {
		p50,
		p95,
		samples: samples.length,
		...(target ? { targetMs: target.p50Ms } : {}),
		...(target?.p95Ms !== undefined ? { targetP95Ms: target.p95Ms } : {}),
		...(target ? { ok: withinTolerance(p50, p95, target) } : {}),
	};
}

function skipped(reason: BenchSkipReason, target: BenchTarget | undefined, detail?: string): BenchMetric {
	return {
		skipped: reason,
		samples: 0,
		...(detail !== undefined ? { detail } : {}),
		...(target ? { targetMs: target.p50Ms } : {}),
	};
}

/** True when no measured metric is over target × tolerance (skipped metrics don't count against it). */
export function benchPassed(result: BenchResult): boolean {
	return Object.values(result).every((metric) => metric === undefined || "skipped" in metric || metric.ok !== false);
}

function statusOf(metric: BenchMetric): string {
	if ("skipped" in metric) return `skip (${metric.skipped})`;
	if (metric.ok === undefined) return "-";
	if (!metric.ok) return "FAIL";
	const slow =
		metric.targetMs !== undefined &&
		(metric.p50 > metric.targetMs || (metric.targetP95Ms !== undefined && metric.p95 > metric.targetP95Ms));
	return slow ? "slow" : "ok";
}

function targetText(metric: BenchMetric): string {
	if (metric.targetMs === undefined) return "-";
	const targetP95 = "targetP95Ms" in metric ? metric.targetP95Ms : undefined;
	return targetP95 === undefined ? `<${metric.targetMs}` : `<${metric.targetMs}/<${targetP95}`;
}

/** `metric p50 p95 n target status`, columns aligned; times in ms with one decimal. */
export function renderBenchTable(result: BenchResult): string {
	const rows: string[][] = [["metric", "p50", "p95", "n", "target", "status"]];
	for (const name of BENCH_METRICS) {
		const metric = result[name];
		if (metric === undefined) continue;
		const measured = !("skipped" in metric);
		rows.push([
			name,
			measured ? metric.p50.toFixed(1) : "-",
			measured ? metric.p95.toFixed(1) : "-",
			String(metric.samples),
			targetText(metric),
			statusOf(metric),
		]);
	}
	const widths = (rows[0] ?? []).map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0)));
	const last = widths.length - 1;
	return rows
		.map((row) =>
			row
				.map((cell, column) =>
					column === 0 || column === last ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0)
				)
				.join("  ")
				.trimEnd()
		)
		.join("\n");
}

type Clock = () => number;

/** Run `once` n times and collect how long each took (ms). A failing run ends the metric with its error. */
async function sample(
	clock: Clock,
	n: number,
	once: () => Promise<Result<unknown, UiError>>
): Promise<Result<number[], UiError>> {
	const out: number[] = [];
	for (let i = 0; i < n; i += 1) {
		const start = clock();
		const done = await once();
		const took = clock() - start;
		if (!done.success) return done;
		out.push(took);
	}
	return ok(out);
}

async function defaultOpenSecond(
	ctx: CommandContext,
	device: UiDevice,
	socketPath: string
): Promise<Result<Driver, UiError>> {
	const opened = await openDriver(
		{
			udid: device.udid,
			platform: device.platform,
			bundleId: "",
			launchArgs: [],
			out: "",
			timeoutMs: 0,
			actionTimeoutMs: 0,
			assertionTimeoutMs: 0,
			logTimestamps: false,
			simdSocket: socketPath,
		},
		{ exec: ctx.exec }
	);
	return opened.success ? opened : { success: false, error: driverUiError(opened.error) };
}

const centre = (width: number, height: number): Point => ({ x: width / 2, y: height / 2 });

const capped = (name: BenchMetricName, runs: number): number => Math.min(runs, SAMPLE_CAPS[name] ?? runs);

/** A driver call's result as the `Result<unknown, UiError>` `sample` wants. */
function viaUi<T>(result: Result<T, Parameters<typeof driverUiError>[0]>): Result<T, UiError> {
	return result.success ? ok(result.data) : { success: false, error: driverUiError(result.error) };
}

/** What one bench run shares between its metric steps. */
type BenchSession = {
	ctx: CommandContext;
	deps: UiDeps;
	opts: BenchOptionValues;
	device: UiDevice;
	env: UiRunEnv;
	runs: number;
	hooks: BenchDeps;
	clock: Clock;
	targets: Partial<Record<BenchMetricName, BenchTarget>>;
	result: BenchResult;
};

/** Summarize `samples` against the metric's target and keep them in the result. */
function recordMetric(session: BenchSession, name: BenchMetricName, samples: number[]): void {
	session.result[name] = summarize(samples, session.targets[name]);
}

/** iOS: stop the helper, then time connect + first snapshot, `runs` times. */
async function benchColdStart(session: BenchSession): Promise<Result<undefined, UiError>> {
	const { ctx, deps, device, hooks, clock } = session;
	const stop = hooks.stopHelper ?? ((c: CommandContext, udid: string) => stopHelper(c, udid));
	const cold: number[] = [];
	for (let i = 0; i < capped("helperColdToSnapshot", session.runs); i += 1) {
		await stop(ctx, device.udid);
		const start = clock();
		const opened = await deps.driver(ctx, device);
		if (!opened.success) return opened;
		const taken = await opened.data.snapshot({ interactiveOnly: true });
		cold.push(clock() - start);
		await opened.data.close().catch(() => undefined);
		if (!taken.success) return { success: false, error: driverUiError(taken.error) };
	}
	recordMetric(session, "helperColdToSnapshot", cold);
	return ok(undefined);
}

/** Warm snapshot and HID tap timings on the open driver. */
async function benchWarm(session: BenchSession, driver: Driver, point: Point): Promise<Result<undefined, UiError>> {
	const { clock, runs } = session;
	const warm = await sample(clock, runs, async () => viaUi(await driver.snapshot({ interactiveOnly: true })));
	if (!warm.success) return warm;
	recordMetric(session, "snapshotWarm", warm.data);

	const press = await sample(clock, runs, async () => viaUi(await driver.tap(point)));
	if (!press.success) return press;
	recordMetric(session, "pressHid", press.data);
	return ok(undefined);
}

/** iOS: tap, then wait for a quiet screen. */
async function benchPressSettle(
	session: BenchSession,
	driver: Driver,
	point: Point
): Promise<Result<undefined, UiError>> {
	const { ctx, deps, device, clock } = session;
	const settle = await sample(clock, capped("pressSettle", session.runs), async () => {
		const tapped = viaUi(await driver.tap(point));
		if (!tapped.success) return tapped;
		return takeSnapshot(ctx, deps, driver, device.udid, {
			interactiveOnly: true,
			all: false,
			settle: { budgetMs: DEFAULT_SETTLE_TIMEOUT_MS },
		});
	});
	if (!settle.success) return settle;
	recordMetric(session, "pressSettle", settle.data);
	return ok(undefined);
}

/** iOS: the dev client's component tree; skipped (not failed) when devtools is unreachable. */
async function benchTree(session: BenchSession): Promise<void> {
	const { ctx, deps, device, env, opts, clock, runs, targets } = session;
	const tree = await withFacet(ctx, deps.devtools ?? defaultDevtoolsDeps, device, env, opts, async (facet) => {
		const fetchTree = async () => {
			const fetched = await facet.tree({ pixelRatio: 1 });
			return fetched.success ? ok(undefined) : { success: false as const, error: devtoolsUiError(fetched.error) };
		};
		const probe = await fetchTree();
		return probe.success ? sample(clock, runs, fetchTree) : probe;
	});
	session.result.tree = tree.success
		? summarize(tree.data, targets.tree)
		: skipped("devtools_unavailable", targets.tree, tree.error.message);
}

/** iOS: connecting a second client to the resident helper socket. */
async function benchOpenSecond(session: BenchSession): Promise<Result<undefined, UiError>> {
	const { ctx, device, hooks, clock } = session;
	const socketPath = readState(ctx, device.udid).helper?.socket ?? socketPathFor(ctx, device.udid);
	const openSecond = hooks.openSecond ?? defaultOpenSecond;
	const second = await sample(clock, capped("openDriver", session.runs), async () => {
		const client = await openSecond(ctx, device, socketPath);
		if (client.success) await client.data.close().catch(() => undefined);
		return client;
	});
	if (!second.success) return second;
	recordMetric(session, "openDriver", second.data);
	return ok(undefined);
}

/** The iOS-only metrics that follow the warm ones. */
async function benchIosRest(session: BenchSession, driver: Driver, point: Point): Promise<Result<undefined, UiError>> {
	const settled = await benchPressSettle(session, driver, point);
	if (!settled.success) return settled;
	await benchTree(session);
	return benchOpenSecond(session);
}

/** The bench's report: the JSON result, the table, and a warning for every metric over target × tolerance. */
function benchReport(session: BenchSession): UiSuccess {
	const { device, runs, result } = session;
	const over = BENCH_METRICS.filter((name) => {
		const metric = result[name];
		return metric !== undefined && !("skipped" in metric) && metric.ok === false;
	});
	return {
		device: { udid: device.udid, platform: device.platform, name: device.name },
		result: { runs, passed: benchPassed(result), metrics: result },
		text: [`# ${device.udid} (${device.platform}) · ${runs} runs`, renderBenchTable(result)].join("\n"),
		warnings: over.length > 0 ? [`over target x${BENCH_TOLERANCE}: ${over.join(", ")}`] : [],
	};
}

/** Every metric in order against the open driver. */
async function benchAll(session: BenchSession): Promise<Result<UiSuccess, UiError>> {
	const ios = session.device.platform === "ios";
	if (ios) {
		const cold = await benchColdStart(session);
		if (!cold.success) return cold;
	}
	const opened = await session.env.driver();
	if (!opened.success) return opened;
	const driver = opened.data;
	const first = viaUi(await driver.snapshot({ interactiveOnly: true }));
	if (!first.success) return first;
	const point = centre(first.data.screen.width, first.data.screen.height);
	const warm = await benchWarm(session, driver, point);
	if (!warm.success) return warm;
	if (ios) {
		const rest = await benchIosRest(session, driver, point);
		if (!rest.success) return rest;
	}
	return ok(benchReport(session));
}

/**
 * `warden ui bench [--runs n]`: time the agent-loop primitives on the leased device and compare them with
 * `BENCH_TARGETS`. The cold-start metric stops the device's helper first, so run it on a device nobody else
 * is using. It taps the screen centre (HID) and takes snapshots, so the generation counter moves.
 */
export function uiBench(ctx: CommandContext, deps: UiDeps, opts: BenchOptionValues): Promise<number> {
	return runUi(ctx, deps, "bench", opts, async (device, env) => {
		const runsParsed = opts.runs === undefined ? ok(DEFAULT_BENCH_RUNS) : positiveInt("--runs", opts.runs);
		if (!runsParsed.success) return runsParsed;
		const hooks = deps.bench ?? {};
		return benchAll({
			ctx,
			deps,
			opts,
			device,
			env,
			runs: runsParsed.data,
			hooks,
			clock: hooks.clock ?? (() => performance.now()),
			targets: BENCH_TARGETS[device.platform],
			result: {},
		});
	});
}
