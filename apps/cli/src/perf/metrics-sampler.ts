import { androidTools } from "@delacour/warden-core/providers/android";
import type { Platform } from "@delacour/warden-core/types";
import { parseMeminfo } from "@delacour/warden-perf/metrics/meminfo";
import {
	type CpuReadings,
	cpuDeltas,
	findByExecutable,
	PS_ENV,
	type PsRow,
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

/** `ps` for one pid, same columns as `PS_ARGS` so `parsePs` reads it unchanged. */
const psPidArgs = (pid: number): string[] => ["ps", "-o", "pid,ppid,rss,%cpu,time,lstart,command", "-p", String(pid)];

/**
 * iOS simulator: simulator processes are host processes and the sim runtime ships no `ps`, so this reads host
 * `ps` for the pid this sim's `launchctl` reports for the app (a system app's executable path is shared by
 * every sim of a runtime), checked against the app's executable. CPU % is the delta of cumulative CPU time over
 * the wall time between readings (`ps %cpu` is a decaying average, useless for a rate); the first reading is the
 * baseline and has no CPU %.
 *
 * Cost: at a 1 s interval the old per-sample `simctl spawn launchctl list` (~95 ms CPU) plus host-wide
 * `ps -axo` (~53 ms) used ~16% of a core. The pid is now resolved once and each sample is a pid-scoped
 * `ps -p` (~2 ms); it is re-resolved only when `ps` has no row for it (process gone) or the row's `lstart`
 * differs from the one recorded at resolution (pid reused). Measured 60 s watch at 1 s: before ~16% of a core, after 0.70 CPU-s over 60.5 s (~1.2%, children included; warden itself 0.24 s).
 */
function iosSampler(ctx: CommandContext, target: MetricsTarget, bundle: IosAppBundle, startMs: number): MetricsSampler {
	const prev: CpuReadings = new Map();
	let lastWallMs: number | undefined;
	let cached: { pid: number; startedAt?: string } | undefined;
	const resolve = async (): Promise<number | undefined> => {
		const pid = await appPid(ctx, { platform: "ios", id: target.udid }, target.app);
		cached = pid === undefined ? undefined : { pid };
		return pid;
	};
	type Read = { kind: "row"; row: PsRow } | { kind: "gone" } | { kind: "error"; error: UiError };
	const read = async (pid: number): Promise<Read> => {
		const res = await ctx.exec(psPidArgs(pid), { timeoutMs: 10_000, env: PS_ENV });
		const row = findByExecutable(
			parsePs(res.stdout).filter((r) => r.pid === pid),
			bundle.executablePath
		);
		if (row !== undefined) return { kind: "row", row };
		if (res.exitCode !== 0 && res.stderr.trim() !== "") {
			return { kind: "error", error: uiError("failed", `ps failed: ${res.stderr.trim()}`) };
		}
		return { kind: "gone" };
	};
	const usable = (r: Read): r is { kind: "row"; row: PsRow } =>
		r.kind === "row" && (cached?.startedAt === undefined || r.row.startedAt === cached.startedAt);
	const locate = async (): Promise<Result<PsRow, UiError>> => {
		const pid = cached?.pid ?? (await resolve());
		if (pid === undefined) return { success: false, error: notRunning(target) };
		let got = await read(pid);
		if (!usable(got) && got.kind !== "error") {
			const fresh = await resolve();
			if (fresh === undefined) return { success: false, error: notRunning(target) };
			got = await read(fresh);
		}
		if (got.kind === "error") return { success: false, error: got.error };
		if (got.kind === "gone") return { success: false, error: notRunning(target) };
		if (cached !== undefined) cached.startedAt ??= got.row.startedAt;
		return ok(got.row);
	};
	return {
		sample: async () => {
			const located = await locate();
			if (!located.success) return located;
			const row = located.data;
			const wallMs = ctx.now();
			const baseline = lastWallMs === undefined;
			const cpuSec = cpuDeltas([row], prev, baseline).get(row.pid);
			const dtSec = baseline ? 0 : (wallMs - (lastWallMs ?? wallMs)) / 1000;
			lastWallMs = wallMs;
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
