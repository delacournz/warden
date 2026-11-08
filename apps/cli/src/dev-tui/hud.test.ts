import { describe, expect, test } from "bun:test";
import { ok, type Result } from "@delacour/warden-types/result";
import { type UiError, uiError } from "../agent-ui/output";
import type { MetricsSampler, MetricsTarget } from "../perf/metrics-sampler";
import { testContext } from "../testing";
import { HUD_MIN_INTERVAL_MS, startHud } from "./hud";
import { HUD_HISTORY, type HudFps, type HudSample } from "./model";

const IOS: MetricsTarget = { udid: "U1", platform: "ios", app: "nz.example" };
const ANDROID: MetricsTarget = { udid: "emulator-5554", platform: "android", app: "nz.example" };

type Reading = Result<{ cpuPct?: number; rssKb: number; pssKb?: number }, UiError>;

function rig(opts: {
	target: () => MetricsTarget | undefined;
	readings: Reading[];
	fps?: (target: MetricsTarget) => Promise<HudFps | undefined>;
	fpsEvery?: number;
	intervalMs?: number;
	tickTimeoutMs?: number;
	hang?: boolean;
}) {
	const samples: Array<{ sample: HudSample; fps: HudFps | undefined }> = [];
	const delays: number[] = [];
	const created: MetricsTarget[] = [];
	let pending: (() => Promise<void>) | undefined;
	let cancelled = 0;
	let reads = 0;
	const hud = startHud({
		ctx: testContext([]),
		target: opts.target,
		intervalMs: opts.intervalMs ?? 1000,
		onSample: (sample, fps) => samples.push({ sample, fps }),
		now: () => 5000,
		...(opts.tickTimeoutMs !== undefined ? { tickTimeoutMs: opts.tickTimeoutMs } : {}),
		...(opts.fps ? { fps: (_ctx, target) => opts.fps?.(target) ?? Promise.resolve(undefined) } : {}),
		...(opts.fpsEvery !== undefined ? { fpsEvery: opts.fpsEvery } : {}),
		sampler: async (_ctx, target) => {
			created.push(target);
			const sampler: MetricsSampler = {
				sample: async () => {
					if (opts.hang) return new Promise<never>(() => undefined);
					const next = opts.readings[Math.min(reads++, opts.readings.length - 1)];
					if (!next) return { success: false, error: uiError("failed", "no reading") };
					return next.success ? ok({ wallMs: 0, atMs: 0, pid: 1, ...next.data }) : next;
				},
			};
			return ok(sampler);
		},
		schedule: (fn, ms) => {
			delays.push(ms);
			pending = fn;
			return () => {
				cancelled++;
				pending = undefined;
			};
		},
	});
	return {
		hud,
		samples,
		delays,
		created,
		cancelled: () => cancelled,
		tick: async () => {
			const fn = pending;
			pending = undefined;
			await fn?.();
		},
		hasPending: () => pending !== undefined,
	};
}

const reading = (cpuPct: number | undefined, rssKb = 182_000): Reading => ({
	success: true,
	data: { ...(cpuPct !== undefined ? { cpuPct } : {}), rssKb },
});

describe("startHud", () => {
	test("shows waiting while the target is unknown, then samples once it is", async () => {
		let target: MetricsTarget | undefined;
		const r = rig({ target: () => target, readings: [reading(12)] });
		await r.tick();
		expect(r.samples.at(-1)?.sample).toEqual({ kind: "waiting" });
		expect(r.created).toHaveLength(0);
		target = IOS;
		await r.tick();
		expect(r.samples.at(-1)?.sample).toEqual({
			kind: "ok",
			cpuPct: 12,
			cpuHistory: [12],
			memKb: 182_000,
			memKind: "rss",
		});
		r.hud.stop();
	});

	test("keeps ticking at the interval and builds one sampler per target", async () => {
		const r = rig({ target: () => IOS, readings: [reading(1), reading(2), reading(3)] });
		await r.tick();
		await r.tick();
		await r.tick();
		expect(r.created).toHaveLength(1);
		expect(r.delays.every((d) => d === 1000 || d === 0)).toBe(true);
		const last = r.samples.at(-1)?.sample;
		expect(last).toMatchObject({ kind: "ok", cpuHistory: [1, 2, 3] });
		r.hud.stop();
	});

	test("a baseline reading without cpu keeps the history empty", async () => {
		const r = rig({ target: () => IOS, readings: [reading(undefined)] });
		await r.tick();
		expect(r.samples.at(-1)?.sample).toMatchObject({ kind: "ok", cpuPct: undefined, cpuHistory: [] });
		r.hud.stop();
	});

	test("the sparkline keeps the last 30 values", async () => {
		const readings = Array.from({ length: 40 }, (_, i) => reading(i));
		const r = rig({ target: () => IOS, readings });
		for (let i = 0; i < 40; i++) await r.tick();
		const last = r.samples.at(-1)?.sample;
		expect(last?.kind === "ok" && last.cpuHistory).toEqual(Array.from({ length: HUD_HISTORY }, (_, i) => i + 10));
		r.hud.stop();
	});

	test("an app that is not running shows app not running and keeps ticking", async () => {
		const gone: Reading = { success: false, error: uiError("app_not_found", "nz.example is not running") };
		const r = rig({ target: () => IOS, readings: [reading(5), gone, reading(7)] });
		await r.tick();
		await r.tick();
		expect(r.samples.at(-1)?.sample).toEqual({ kind: "not-running", reason: "nz.example is not running" });
		expect(r.hasPending()).toBe(true);
		await r.tick();
		expect(r.samples.at(-1)?.sample).toMatchObject({ kind: "ok", cpuHistory: [5, 7] });
		r.hud.stop();
	});

	test("a sampler that throws never escapes the ticker", async () => {
		const r = rig({ target: () => IOS, readings: [] });
		await r.tick();
		expect(r.samples.at(-1)?.sample).toEqual({ kind: "not-running", reason: "no reading" });
		expect(r.hasPending()).toBe(true);
		r.hud.stop();
	});

	test("Android reads PSS and fps with jank every tick", async () => {
		const fps = async () => ({ fps: 59, jankPct: 2 });
		const r = rig({
			target: () => ANDROID,
			readings: [{ success: true, data: { cpuPct: 30, rssKb: 300_000, pssKb: 150_000 } }],
			fps,
		});
		await r.tick();
		expect(r.samples.at(-1)).toEqual({
			sample: { kind: "ok", cpuPct: 30, cpuHistory: [30], memKb: 150_000, memKind: "pss" },
			fps: { fps: 59, jankPct: 2 },
		});
		r.hud.stop();
	});

	test("fpsEvery 3 reads frame stats on the first tick then every third, keeping the last value between", async () => {
		let reads = 0;
		const r = rig({
			target: () => ANDROID,
			readings: [{ success: true, data: { cpuPct: 1, rssKb: 1, pssKb: 1 } }],
			fps: async () => ({ fps: 50 + reads++, jankPct: 0 }),
			fpsEvery: 3,
		});
		for (let i = 0; i < 4; i++) await r.tick();
		expect(r.samples.map((s) => s.fps?.fps)).toEqual([50, 50, 50, 51]);
		r.hud.stop();
	});

	test("iOS never asks for fps", async () => {
		let asked = 0;
		const r = rig({
			target: () => IOS,
			readings: [reading(1)],
			fps: async () => {
				asked++;
				return { fps: 60, jankPct: 0 };
			},
		});
		await r.tick();
		expect(asked).toBe(0);
		expect(r.samples.at(-1)?.fps).toBeUndefined();
		r.hud.stop();
	});

	test("stop cancels the pending tick and ends the ticker", async () => {
		const r = rig({ target: () => IOS, readings: [reading(1)] });
		await r.tick();
		expect(r.hasPending()).toBe(true);
		r.hud.stop();
		expect(r.hasPending()).toBe(false);
		expect(r.cancelled()).toBeGreaterThan(0);
		const before = r.samples.length;
		await r.tick();
		expect(r.samples).toHaveLength(before);
	});

	test("an interval below the floor is raised to 200 ms", async () => {
		const r = rig({ target: () => IOS, readings: [reading(1)], intervalMs: 50 });
		await r.tick();
		expect(r.delays.at(-1)).toBe(HUD_MIN_INTERVAL_MS);
		r.hud.stop();
	});

	test("a sampler that never answers times out as not running and the ticker carries on", async () => {
		const r = rig({ target: () => IOS, readings: [], hang: true, tickTimeoutMs: 20 });
		await r.tick();
		expect(r.samples.at(-1)?.sample).toEqual({ kind: "not-running", reason: "no reading within 20 ms" });
		expect(r.hasPending()).toBe(true);
		r.hud.stop();
	});

	test("a sampler that cannot be built reports why", async () => {
		const samples: HudSample[] = [];
		let first = true;
		const hud = startHud({
			ctx: testContext([]),
			target: () => IOS,
			intervalMs: 1000,
			onSample: (sample) => samples.push(sample),
			now: () => 0,
			sampler: async () => ({ success: false, error: uiError("app_not_found", "nz.example is not installed") }),
			schedule: (fn) => {
				if (first) void fn();
				first = false;
				return () => undefined;
			},
		});
		await Bun.sleep(5);
		hud.stop();
		expect(samples.at(-1)).toEqual({ kind: "not-running", reason: "nz.example is not installed" });
	});
});
