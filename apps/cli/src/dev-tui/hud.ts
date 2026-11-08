import { parseDuration } from "@delacour/warden-core/duration";
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import type { MetricsSampler, MetricsTarget } from "../perf/metrics-sampler";
import { HUD_HISTORY, type HudFps, type HudSample } from "./model";

type SamplerResult = Awaited<ReturnType<typeof import("../perf/metrics-sampler").createSampler>>;

/** The HUD never samples faster than this, whatever `--hud-interval` says. */
export const HUD_MIN_INTERVAL_MS = 200;
export const HUD_DEFAULT_INTERVAL_MS = 1000;
/** One tick (sampler build + reading + frame stats) gets this long before it is reported as not running. */
export const HUD_TICK_TIMEOUT_MS = 15_000;

/** `--hud-interval 750ms` → 750; under the 200 ms floor is an error rather than a silent raise. */
export function parseHudInterval(raw: string): Result<number> {
	const parsed = parseDuration(raw);
	if (!parsed.success) return parsed;
	if (parsed.data < HUD_MIN_INTERVAL_MS) return err(`${raw} is under the ${HUD_MIN_INTERVAL_MS}ms minimum`);
	return ok(parsed.data);
}

export type HudDeps = {
	ctx: CommandContext;
	/** the dev client on the leased device; undefined until `ready()` */
	target: () => MetricsTarget | undefined;
	intervalMs: number;
	onSample: (sample: HudSample, fps: HudFps | undefined) => void;
	now: () => number;
	/** Android frame stats for the target (default: `dumpsys gfxinfo` via `androidFrameRate`); iOS is never asked */
	fps?: (ctx: CommandContext, target: MetricsTarget) => Promise<HudFps | undefined>;
	/** read frame stats on the first tick and then every Nth (default 1) */
	fpsEvery?: number;
	/** test seam: the sampler for a target (default: the `perf metrics` sampler, loaded on first use) */
	sampler?: (ctx: CommandContext, target: MetricsTarget, startMs: number) => Promise<SamplerResult>;
	/** a reading that takes longer than this counts as `not-running` (default 15 s); the ticker never waits on a hung tool */
	tickTimeoutMs?: number;
	/** test seam: run `fn` after `ms`; returns a cancel (default: `setTimeout`) */
	schedule?: (fn: () => Promise<void>, ms: number) => () => void;
};

export type Hud = { stop(): void };

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const sameTarget = (a: MetricsTarget, b: MetricsTarget): boolean =>
	a.udid === b.udid && a.platform === b.platform && a.app === b.app;

async function defaultSampler(ctx: CommandContext, target: MetricsTarget, startMs: number): Promise<SamplerResult> {
	const { createSampler } = await import("../perf/metrics-sampler");
	return createSampler(ctx, target, startMs);
}

async function defaultFps(ctx: CommandContext, target: MetricsTarget): Promise<HudFps | undefined> {
	const { androidFrameRate } = await import("../perf/frames");
	return androidFrameRate(ctx, target.udid, target.app);
}

const defaultSchedule = (fn: () => Promise<void>, ms: number): (() => void) => {
	const timer = setTimeout(() => void fn(), ms);
	return () => clearTimeout(timer);
};

/**
 * The HUD's ticker: every `intervalMs` (at least 200 ms) one reading of the dev client through the `perf metrics`
 * sampler, plus frame stats on Android. The target appears at `ready()`, so ticks before that report `waiting`.
 * A missing app reports `not-running` and the ticker carries on; nothing it does throws out of it. Stops on `stop()`.
 */
export function startHud(deps: HudDeps): Hud {
	const interval = Math.max(HUD_MIN_INTERVAL_MS, deps.intervalMs);
	const schedule = deps.schedule ?? defaultSchedule;
	const makeSampler = deps.sampler ?? defaultSampler;
	const readFps = deps.fps ?? defaultFps;
	const fpsEvery = Math.max(1, Math.floor(deps.fpsEvery ?? 1));
	let stopped = false;
	let cancel: (() => void) | undefined;
	let current: { target: MetricsTarget; sampler: MetricsSampler } | undefined;
	let history: number[] = [];
	let fps: HudFps | undefined;
	let ticks = 0;

	const emit = (sample: HudSample): void => {
		if (stopped) return;
		try {
			deps.onSample(sample, fps);
		} catch {
			// a failing consumer must not stop the ticker
		}
	};

	const samplerFor = async (target: MetricsTarget): Promise<Result<MetricsSampler, string>> => {
		if (current && sameTarget(current.target, target)) return ok(current.sampler);
		const made = await makeSampler(deps.ctx, target, deps.now());
		if (!made.success) return err(made.error.message);
		current = { target, sampler: made.data };
		history = [];
		fps = undefined;
		ticks = 0;
		return ok(made.data);
	};

	const frameStats = async (target: MetricsTarget): Promise<void> => {
		if (target.platform !== "android") return;
		if (ticks % fpsEvery === 0) fps = (await readFps(deps.ctx, target)) ?? fps;
		ticks++;
	};

	const tick = async (): Promise<void> => {
		const target = deps.target();
		if (target === undefined) return emit({ kind: "waiting" });
		const sampler = await samplerFor(target);
		if (!sampler.success) return emit({ kind: "not-running", reason: sampler.error });
		const read = await sampler.data.sample();
		if (!read.success) return emit({ kind: "not-running", reason: read.error.message });
		const { cpuPct, rssKb, pssKb } = read.data;
		if (cpuPct !== undefined) history = [...history, cpuPct].slice(-HUD_HISTORY);
		await frameStats(target);
		const pss = target.platform === "android" ? pssKb : undefined;
		emit({
			kind: "ok",
			cpuPct,
			cpuHistory: history,
			memKb: pss ?? rssKb,
			memKind: pss === undefined ? "rss" : "pss",
		});
	};

	const timeoutMs = deps.tickTimeoutMs ?? HUD_TICK_TIMEOUT_MS;
	const timedOut = (): Promise<"timeout"> =>
		new Promise((resolve) => {
			const timer = setTimeout(() => resolve("timeout"), timeoutMs);
			// a finished tick must not keep the process (or a test) waiting on the watchdog
			timer.unref?.();
		});

	const run = async (): Promise<void> => {
		if (stopped) return;
		try {
			const outcome = await Promise.race([tick(), timedOut()]);
			if (outcome === "timeout") emit({ kind: "not-running", reason: `no reading within ${timeoutMs} ms` });
		} catch (error) {
			emit({ kind: "not-running", reason: message(error) });
		}
		if (!stopped) cancel = schedule(run, interval);
	};

	cancel = schedule(run, 0);
	return {
		stop() {
			stopped = true;
			cancel?.();
			cancel = undefined;
		},
	};
}
