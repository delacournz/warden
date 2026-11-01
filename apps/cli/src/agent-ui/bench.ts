import { driverOpener } from "@delacour/warden-device/open";
import type { Driver, Point } from "@delacour/warden-driver/driver.types";
import { DEFAULT_SETTLE_TIMEOUT_MS } from "@delacour/warden-driver/settle";
import { uiadBackendRules } from "@delacour/warden-driver-android/uiad-backend";
import { androidToolsLocator } from "@delacour/warden-providers/android-tools";
import { devtoolsOps } from "@delacour/warden-sdk/ops/devtools";
import { snapshotOps } from "@delacour/warden-sdk/ops/snapshot";
import { storeLocator } from "@delacour/warden-store/store";
import type { Platform } from "@delacour/warden-store/types";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { uiArgs } from "./args";
import type { UiDevice } from "./device";
import { defaultDevtoolsDeps } from "./devtools-cli";
import { opErrors, type UiDeps } from "./driver";
import { uiHelper } from "./helper";
import type { UiError, UiSuccess } from "./output";
import { type UiOptionValues, type UiRunEnv, uiRun } from "./run";
import { uiSession } from "./session";
import { uiStatePersistence } from "./state";

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

type Clock = () => number;

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

export class UiBench {
	/** Nearest-rank percentile of an ascending list (`q` in 0..1). */
	percentile(sorted: readonly number[], q: number): number {
		if (sorted.length === 0) return Number.NaN;
		const rank = Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length)));
		return sorted[rank - 1] ?? Number.NaN;
	}

	private round1(ms: number) {
		return Math.round(ms * 10) / 10;
	}

	/** Does the measurement stay within target × tolerance (p50, and p95 when the target has one)? */
	withinTolerance(p50: number, p95: number, target: BenchTarget): boolean {
		if (p50 > target.p50Ms * BENCH_TOLERANCE) return false;
		return target.p95Ms === undefined || p95 <= target.p95Ms * BENCH_TOLERANCE;
	}

	/** Percentiles of `samples` (ms), judged against `target` when there is one. */
	summarize(samples: readonly number[], target: BenchTarget | undefined): BenchMetric {
		const sorted = [...samples].sort((a, b) => a - b);
		const p50 = this.round1(this.percentile(sorted, 0.5));
		const p95 = this.round1(this.percentile(sorted, 0.95));
		return {
			p50,
			p95,
			samples: samples.length,
			...(target ? { targetMs: target.p50Ms } : {}),
			...(target?.p95Ms !== undefined ? { targetP95Ms: target.p95Ms } : {}),
			...(target ? { ok: this.withinTolerance(p50, p95, target) } : {}),
		};
	}

	private skipped(reason: BenchSkipReason, target: BenchTarget | undefined, detail?: string): BenchMetric {
		return {
			skipped: reason,
			samples: 0,
			...(detail !== undefined ? { detail } : {}),
			...(target ? { targetMs: target.p50Ms } : {}),
		};
	}

	/** True when no measured metric is over target × tolerance (skipped metrics don't count against it). */
	benchPassed(result: BenchResult): boolean {
		return Object.values(result).every((metric) => metric === undefined || "skipped" in metric || metric.ok !== false);
	}

	private statusOf(metric: BenchMetric): string {
		if ("skipped" in metric) return `skip (${metric.skipped})`;
		if (metric.ok === undefined) return "-";
		if (!metric.ok) return "FAIL";
		const slow =
			metric.targetMs !== undefined &&
			(metric.p50 > metric.targetMs || (metric.targetP95Ms !== undefined && metric.p95 > metric.targetP95Ms));
		return slow ? "slow" : "ok";
	}

	private targetText(metric: BenchMetric): string {
		if (metric.targetMs === undefined) return "-";
		const targetP95 = "targetP95Ms" in metric ? metric.targetP95Ms : undefined;
		return targetP95 === undefined ? `<${metric.targetMs}` : `<${metric.targetMs}/<${targetP95}`;
	}

	/** `metric p50 p95 n target status`, columns aligned; times in ms with one decimal. */
	renderBenchTable(result: BenchResult): string {
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
				this.targetText(metric),
				this.statusOf(metric),
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

	/** Run `once` n times and collect how long each took (ms). A failing run ends the metric with its error. */
	private async sample(
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
		return resultFactory.ok(out);
	}

	private readonly defaultOpenSecond = async (
		ctx: CommandContext,
		device: UiDevice,
		socketPath: string
	): Promise<Result<Driver, UiError>> => {
		const opened = await driverOpener.open({
			platform: device.platform,
			id: device.udid,
			host: { exec: ctx.exec, home: storeLocator.wardenHome(ctx.env) },
			ios: { socketPath },
			android: { adb: androidToolsLocator.locate(ctx.env).adb, uiad: uiadBackendRules.uiadFromEnv(ctx.env) ?? false },
		});
		return opened.success ? opened : { success: false, error: opErrors.driverError(opened.error) };
	};

	private centre(width: number, height: number): Point {
		return { x: width / 2, y: height / 2 };
	}

	private capped(name: BenchMetricName, runs: number): number {
		return Math.min(runs, SAMPLE_CAPS[name] ?? runs);
	}

	/** A driver call's result as the `Result<unknown, UiError>` `sample` wants. */
	private viaUi<T>(result: Result<T, Parameters<typeof opErrors.driverError>[0]>): Result<T, UiError> {
		return result.success
			? resultFactory.ok(result.data)
			: { success: false, error: opErrors.driverError(result.error) };
	}

	/** Summarize `samples` against the metric's target and keep them in the result. */
	private recordMetric(session: BenchSession, name: BenchMetricName, samples: number[]): void {
		session.result[name] = this.summarize(samples, session.targets[name]);
	}

	/** iOS: stop the helper, then time connect + first snapshot, `runs` times. */
	private async benchColdStart(session: BenchSession): Promise<Result<undefined, UiError>> {
		const { ctx, deps, device, hooks, clock } = session;
		const stop = hooks.stopHelper ?? ((c: CommandContext, udid: string) => uiHelper.stopHelper(c, udid));
		const cold: number[] = [];
		for (let i = 0; i < this.capped("helperColdToSnapshot", session.runs); i += 1) {
			await stop(ctx, device.udid);
			const start = clock();
			const opened = await deps.driver(ctx, device);
			if (!opened.success) return opened;
			const taken = await opened.data.snapshot({ interactiveOnly: true });
			cold.push(clock() - start);
			await opened.data.close().catch(() => undefined);
			if (!taken.success) return { success: false, error: opErrors.driverError(taken.error) };
		}
		this.recordMetric(session, "helperColdToSnapshot", cold);
		return resultFactory.ok(undefined);
	}

	/** The SDK op session the iOS bench steps (settled snapshot, component tree) run through. */
	private benchOpSession(session: BenchSession) {
		const { ctx, deps, device, env } = session;
		return uiSession.opSessionFor(ctx, deps, device, env, { devtools: deps.devtools ?? defaultDevtoolsDeps });
	}

	/** Warm snapshot and HID tap timings on the open driver. */
	private async benchWarm(session: BenchSession, driver: Driver, point: Point): Promise<Result<undefined, UiError>> {
		const { clock, runs } = session;
		const warm = await this.sample(clock, runs, async () =>
			this.viaUi(await driver.snapshot({ interactiveOnly: true }))
		);
		if (!warm.success) return warm;
		this.recordMetric(session, "snapshotWarm", warm.data);

		const press = await this.sample(clock, runs, async () => this.viaUi(await driver.tap(point)));
		if (!press.success) return press;
		this.recordMetric(session, "pressHid", press.data);
		return resultFactory.ok(undefined);
	}

	/** iOS: tap, then wait for a quiet screen. */
	private async benchPressSettle(
		session: BenchSession,
		driver: Driver,
		point: Point
	): Promise<Result<undefined, UiError>> {
		const { clock } = session;
		const ops = this.benchOpSession(session);
		const settle = await this.sample(clock, this.capped("pressSettle", session.runs), async () => {
			const tapped = this.viaUi(await driver.tap(point));
			if (!tapped.success) return tapped;
			return snapshotOps.takeSnapshot(ops, driver, {
				interactiveOnly: true,
				all: false,
				settle: { budgetMs: DEFAULT_SETTLE_TIMEOUT_MS },
			});
		});
		if (!settle.success) return settle;
		this.recordMetric(session, "pressSettle", settle.data);
		return resultFactory.ok(undefined);
	}

	/** iOS: the dev client's component tree; skipped (not failed) when devtools is unreachable. */
	private async benchTree(session: BenchSession): Promise<void> {
		const { opts, clock, runs, targets } = session;
		const tree = await devtoolsOps.withFacet(this.benchOpSession(session), opts, async (facet) => {
			const fetchTree = async () => {
				const fetched = await facet.tree({ pixelRatio: 1 });
				return fetched.success
					? resultFactory.ok(undefined)
					: { success: false as const, error: devtoolsOps.devtoolsError(fetched.error) };
			};
			const probe = await fetchTree();
			return probe.success ? this.sample(clock, runs, fetchTree) : probe;
		});
		session.result.tree = tree.success
			? this.summarize(tree.data, targets.tree)
			: this.skipped("devtools_unavailable", targets.tree, tree.error.message);
	}

	/** iOS: connecting a second client to the resident helper socket. */
	private async benchOpenSecond(session: BenchSession): Promise<Result<undefined, UiError>> {
		const { ctx, device, hooks, clock } = session;
		const socketPath =
			uiStatePersistence.readState(ctx, device.udid).helper?.socket ?? uiHelper.socketPathFor(ctx, device.udid);
		const openSecond = hooks.openSecond ?? this.defaultOpenSecond;
		const second = await this.sample(clock, this.capped("openDriver", session.runs), async () => {
			const client = await openSecond(ctx, device, socketPath);
			if (client.success) await client.data.close().catch(() => undefined);
			return client;
		});
		if (!second.success) return second;
		this.recordMetric(session, "openDriver", second.data);
		return resultFactory.ok(undefined);
	}

	/** The iOS-only metrics that follow the warm ones. */
	private async benchIosRest(session: BenchSession, driver: Driver, point: Point): Promise<Result<undefined, UiError>> {
		const settled = await this.benchPressSettle(session, driver, point);
		if (!settled.success) return settled;
		await this.benchTree(session);
		return this.benchOpenSecond(session);
	}

	/** The bench's report: the JSON result, the table, and a warning for every metric over target × tolerance. */
	private benchReport(session: BenchSession): UiSuccess {
		const { device, runs, result } = session;
		const over = BENCH_METRICS.filter((name) => {
			const metric = result[name];
			return metric !== undefined && !("skipped" in metric) && metric.ok === false;
		});
		return {
			device: { udid: device.udid, platform: device.platform, name: device.name },
			result: { runs, passed: this.benchPassed(result), metrics: result },
			text: [`# ${device.udid} (${device.platform}) · ${runs} runs`, this.renderBenchTable(result)].join("\n"),
			warnings: over.length > 0 ? [`over target x${BENCH_TOLERANCE}: ${over.join(", ")}`] : [],
		};
	}

	/** Every metric in order against the open driver. */
	private async benchAll(session: BenchSession): Promise<Result<UiSuccess, UiError>> {
		const ios = session.device.platform === "ios";
		if (ios) {
			const cold = await this.benchColdStart(session);
			if (!cold.success) return cold;
		}
		const opened = await session.env.driver();
		if (!opened.success) return opened;
		const driver = opened.data;
		const first = this.viaUi(await driver.snapshot({ interactiveOnly: true }));
		if (!first.success) return first;
		const point = this.centre(first.data.screen.width, first.data.screen.height);
		const warm = await this.benchWarm(session, driver, point);
		if (!warm.success) return warm;
		if (ios) {
			const rest = await this.benchIosRest(session, driver, point);
			if (!rest.success) return rest;
		}
		return resultFactory.ok(this.benchReport(session));
	}

	/**
	 * `warden ui bench [--runs n]`: time the agent-loop primitives on the leased device and compare them with
	 * `BENCH_TARGETS`. The cold-start metric stops the device's helper first, so run it on a device nobody else
	 * is using. It taps the screen centre (HID) and takes snapshots, so the generation counter moves.
	 */
	run(ctx: CommandContext, deps: UiDeps, opts: BenchOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "bench", opts, async (device, env) => {
			const runsParsed =
				opts.runs === undefined ? resultFactory.ok(DEFAULT_BENCH_RUNS) : uiArgs.positiveInt("--runs", opts.runs);
			if (!runsParsed.success) return runsParsed;
			const hooks = deps.bench ?? {};
			return this.benchAll({
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
}

export const uiBench = new UiBench();
