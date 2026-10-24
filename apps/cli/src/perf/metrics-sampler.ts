import { androidTools } from "@delacour/warden-core/providers/android";
import type { Platform } from "@delacour/warden-core/types";
import { parseMeminfo } from "@delacour/warden-perf/metrics/meminfo";
import {
	type CpuReadings,
	cpuDeltas,
	findByExecutable,
	PS_ARGS,
	PS_ENV,
	parseAdbTop,
	parsePs,
} from "@delacour/warden-perf/metrics/ps";
import type { MetricSample } from "@delacour/warden-perf/metrics/series";
import { ok, type Result } from "@delacour/warden-types/result";
import { type UiError, uiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { appPid, type IosAppBundle, iosAppBundle } from "./app-process";

export type MetricsTarget = { udid: string; platform: Platform; app: string };

/**
 * Frames per second over the interval since the previous call, or undefined when unknown. `perf metrics --watch`
 * draws an fps sparkline only when one is supplied (Android reads it from gfxinfo deltas).
 */
export type FrameRateSource = (read: { atMs: number; wallMs: number }) => Promise<number | undefined>;

export type MetricsSampler = {
	/** one reading of the app; `atMs` counts from the sampler's `startMs` */
	sample: () => Promise<Result<MetricSample, UiError>>;
};

const notRunning = (target: MetricsTarget): UiError =>
	uiError("app_not_found", `${target.app} is not running on ${target.udid}`, {
		hint: "launch the app first (warden ui open <app>)",
	});

/**
 * iOS simulator: `simctl spawn ps` matched on the app's executable path. CPU % is the delta of cumulative CPU
 * time over the wall time between readings (`ps %cpu` is a decaying average, useless for a rate); the first
 * reading is the baseline and has no CPU %.
 */
function iosSampler(ctx: CommandContext, target: MetricsTarget, bundle: IosAppBundle, startMs: number): MetricsSampler {
	const prev: CpuReadings = new Map();
	let lastWallMs: number | undefined;
	return {
		sample: async () => {
			const res = await ctx.exec(["xcrun", "simctl", "spawn", target.udid, "ps", ...PS_ARGS], {
				timeoutMs: 10_000,
				env: PS_ENV,
			});
			const wallMs = ctx.now();
			if (res.exitCode !== 0) {
				return {
					success: false,
					error: uiError("failed", `ps failed on ${target.udid}: ${res.stderr.trim() || `exit ${res.exitCode}`}`),
				};
			}
			const rows = parsePs(res.stdout);
			const row = findByExecutable(rows, bundle.executablePath);
			if (row === undefined) return { success: false, error: notRunning(target) };
			const baseline = lastWallMs === undefined;
			const deltas = cpuDeltas(rows, prev, baseline);
			const dtSec = baseline ? 0 : (wallMs - (lastWallMs ?? wallMs)) / 1000;
			lastWallMs = wallMs;
			const cpuSec = deltas.get(row.pid);
			return ok({
				wallMs,
				atMs: wallMs - startMs,
				pid: row.pid,
				...(!baseline && dtSec > 0 && cpuSec !== undefined ? { cpuPct: round1((cpuSec / dtSec) * 100) } : {}),
				rssKb: row.rssKb,
			});
		},
	};
}

/**
 * Android: `top -n 1 -b -p <pid>` for CPU % and RES (fallback RSS), `dumpsys meminfo <pkg>` for TOTAL PSS/RSS.
 * The pid is cached and re-resolved once when top no longer lists it (the app restarted).
 */
function androidSampler(ctx: CommandContext, target: MetricsTarget, startMs: number): MetricsSampler {
	const adb = androidTools(ctx.env).adb;
	let pid: number | undefined;
	const top = async (p: number) => {
		const res = await ctx.exec([adb, "-s", target.udid, "shell", "top", "-n", "1", "-b", "-p", String(p)], {
			timeoutMs: 10_000,
		});
		return res.exitCode === 0 ? parseAdbTop(res.stdout).find((r) => r.pid === p) : undefined;
	};
	return {
		sample: async () => {
			pid ??= await appPid(ctx, { platform: "android", id: target.udid }, target.app);
			let row = pid === undefined ? undefined : await top(pid);
			if (row === undefined) {
				pid = await appPid(ctx, { platform: "android", id: target.udid }, target.app);
				row = pid === undefined ? undefined : await top(pid);
			}
			if (pid === undefined || row === undefined) return { success: false, error: notRunning(target) };
			const mem = await ctx.exec([adb, "-s", target.udid, "shell", "dumpsys", "meminfo", target.app], {
				timeoutMs: 15_000,
			});
			const info = mem.exitCode === 0 ? parseMeminfo(mem.stdout) : undefined;
			const wallMs = ctx.now();
			return ok({
				wallMs,
				atMs: wallMs - startMs,
				pid,
				cpuPct: row.cpuPct,
				rssKb: info?.totalRssKb ?? Math.round(row.rssBytes / 1024),
				...(info !== undefined ? { pssKb: info.totalPssKb } : {}),
			});
		},
	};
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** A sampler for the app on the device; fails when an iOS app is not installed. Observe-only: reads, never touches the app. */
export async function createSampler(
	ctx: CommandContext,
	target: MetricsTarget,
	startMs: number
): Promise<Result<MetricsSampler, UiError>> {
	if (target.platform === "android") return ok(androidSampler(ctx, target, startMs));
	const bundle = await iosAppBundle(ctx, target.udid, target.app);
	return bundle.success ? ok(iosSampler(ctx, target, bundle.data, startMs)) : bundle;
}
