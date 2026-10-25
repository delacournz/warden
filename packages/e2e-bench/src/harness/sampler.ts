import { basename } from "node:path";
import {
	type AdbTopRow,
	type CpuReadings,
	cpuDeltas,
	PS_ARGS,
	PS_ENV,
	type PsRow,
	parseAdbTop,
	parsePs,
	withDescendants,
} from "@delacour/warden-perf/metrics/ps";
import type { GroupSeries, HostGroup, Platform, RepResources, Series } from "../results/schema";
import type { Exec } from "./exec";

/**
 * What counts as "the sim" on Android: the app under test and every framework's on-device helper, matched
 * on the `top` ARGS column (a package for app processes, the whole command line for `app_process` ones).
 * Case-insensitive, because class names differ in case (`SnapshotInstrumentation`).
 * - `nz.co.delacour.warden.example`: the app and its `.test` instrumentation apk
 * - `uiautomator`: warden's `uiautomator dump`, argent's and agent-device's fallbacks
 * - `instrumentation`: androidx.test runners, agent-device's `SnapshotInstrumentation`
 * - `dev.mobile.maestro`: Maestro's driver app and its `.test` apk
 * - `com.callstack.agentdevice`: agent-device's snapshot helper (also what tester-army drives)
 * - `com.argent.`: argent's `androiddevtools` helper
 * - `warden-uiad`: warden's resident uiautomator server, an `app_process` that renames itself
 */
const ANDROID_TARGET = new RegExp(
	[
		String.raw`nz\.co\.delacour\.warden\.example`,
		"uiautomator",
		"instrumentation",
		String.raw`dev\.mobile\.maestro`,
		String.raw`com\.callstack\.agentdevice`,
		String.raw`com\.argent\.`,
		"warden[-_.]?uiad",
	].join("|"),
	"i"
);

/** True when a `top` ARGS name is the app under test or a framework's on-device helper. */
export function isAndroidTarget(name: string): boolean {
	return ANDROID_TARGET.test(name);
}

/** Total CPU% and RSS of the app and every framework's on-device helpers (see `ANDROID_TARGET`). */
export function androidTotals(rows: readonly AdbTopRow[]): { cpuPct: number; rssBytes: number } {
	let cpuPct = 0;
	let rssBytes = 0;
	for (const r of rows) {
		if (!isAndroidTarget(r.name)) continue;
		cpuPct += r.cpuPct;
		rssBytes += r.rssBytes;
	}
	return { cpuPct, rssBytes };
}

type Reading = { cpuPct: number; rssBytes: number; cpuSec: number };

function total(
	rows: readonly PsRow[],
	pids: ReadonlySet<number>,
	deltas: ReadonlyMap<number, number>,
	groupOf?: (row: PsRow) => HostGroup
): Reading & { byGroup: Partial<Record<HostGroup, TickGroup>> } {
	let cpuPct = 0;
	let rssKb = 0;
	let cpuSec = 0;
	const byGroup: Partial<Record<HostGroup, TickGroup>> = {};
	for (const r of rows) {
		if (!pids.has(r.pid)) continue;
		const d = deltas.get(r.pid) ?? 0;
		cpuPct += r.cpuPct;
		rssKb += r.rssKb;
		cpuSec += d;
		if (groupOf === undefined) continue;
		const g = groupOf(r);
		const prev = byGroup[g] ?? { cpuSec: 0, rssBytes: 0 };
		byGroup[g] = { cpuSec: prev.cpuSec + d, rssBytes: prev.rssBytes + r.rssKb * 1024 };
	}
	return { cpuPct, rssBytes: rssKb * 1024, cpuSec, byGroup };
}

const BUN_CLI = /(^|\/)apps\/cli\/src\/cli\.ts$/;

/**
 * A process's group from its own argv: `argv0` (path or name) and the first argument. Undefined when argv
 * alone does not say (a plain `bun run`, java, xcrun): the caller then falls back to the spawn label.
 */
export function groupOfArgv(argv0: string, arg1: string | undefined): HostGroup | undefined {
	const name = basename(argv0);
	if (name === "warden-simd") return "warden-simd";
	if (name === "warden") return "warden-cli";
	if (name === "adb") return "adb";
	if (name === "emulator" || name.startsWith("qemu-system")) return "emulator";
	if (name === "bun" || name.startsWith("bun-")) {
		if (arg1 === "test") return "bun-test";
		if (arg1 !== undefined && BUN_CLI.test(arg1)) return "warden-cli";
	}
	return undefined;
}

/**
 * A host row's group: its own argv (`groupOfArgv`), else that of the nearest ancestor whose argv or
 * spawn label (`labels`, from `trackingExec`) names one, else `other`. Argv comes first on every ancestor,
 * so an `xcrun` under `warden-simd` under `bun test` is `warden-simd`.
 */
export function hostGroupOf(
	row: PsRow,
	byPid: ReadonlyMap<number, PsRow>,
	labels: ReadonlyMap<number, HostGroup>
): HostGroup {
	const seen = new Set<number>();
	for (let cur: PsRow | undefined = row; cur !== undefined && !seen.has(cur.pid); cur = byPid.get(cur.ppid)) {
		seen.add(cur.pid);
		const [argv0 = "", arg1] = cur.command.split(/\s+/);
		const own = groupOfArgv(argv0, arg1);
		if (own !== undefined) return own;
		const label = labels.get(cur.pid);
		if (label !== undefined) return label;
	}
	return "other";
}

/** Per-pid verdict from `liveRoots`: the process first seen under that pid, or "never trust this pid". */
export type PidStamp = { kind: "started"; startedAt: string } | { kind: "ignored" };
export type PidStamps = Map<number, PidStamp>;

/**
 * The registered root pids that still belong to the process the bench spawned. The bench registers every
 * child pid for the whole session, and the OS reuses pids, so a bare pid set would one day count an
 * unrelated process (and its children) as bench load. Each root is stamped with its `lstart` the first
 * time it is looked at and only counts while that start time still matches. A root that is not in `rows`
 * the first time (a short-lived child that exited before a tick) is never trusted again, because
 * whatever holds that pid later is somebody else. Rows without a start time (plain ps output) cannot be
 * checked and count, as before.
 */
export function liveRoots(rootPids: readonly number[], rows: readonly PsRow[], stamps: PidStamps): number[] {
	const byPid = new Map(rows.map((r) => [r.pid, r]));
	const live: number[] = [];
	for (const pid of rootPids) {
		const row = byPid.get(pid);
		const stamp = stamps.get(pid);
		if (stamp === undefined) {
			if (row === undefined) {
				stamps.set(pid, { kind: "ignored" });
				continue;
			}
			if (row.startedAt !== undefined) stamps.set(pid, { kind: "started", startedAt: row.startedAt });
			live.push(pid);
			continue;
		}
		if (stamp.kind === "started" && row?.startedAt === stamp.startedAt) live.push(pid);
	}
	return live;
}

/** Per live root, the last `ps time` reading of every process seen in its tree (for its exit charge). */
export type TreeReadings = Map<number, Map<number, number>>;

/** Records this snapshot's readings of each root's tree in `trees` (a process that died keeps its last one). */
export function recordTrees(rows: readonly PsRow[], roots: readonly number[], trees: TreeReadings): void {
	const byPid = new Map(rows.map((r) => [r.pid, r]));
	for (const root of roots) {
		const seen = trees.get(root) ?? new Map<number, number>();
		for (const pid of withDescendants(rows, new Set([root]))) {
			const sec = byPid.get(pid)?.cpuTimeSec;
			if (sec !== undefined) seen.set(pid, sec);
		}
		trees.set(root, seen);
	}
}

/** Roots from `rootPids` plus any owned process whose command matches a pattern, with all their descendants. */
export function hostPids(
	rows: readonly PsRow[],
	rootPids: readonly number[],
	patterns: readonly RegExp[],
	owned: readonly PsRow[]
): Set<number> {
	const seeds = new Set(rootPids);
	for (const r of owned) if (patterns.some((p) => p.test(r.command))) seeds.add(r.pid);
	return withDescendants(rows, seeds);
}

/** iOS simulator processes: anything mentioning the udid (launchd_sim) and its descendants, minus the host set. */
export function simPids(rows: readonly PsRow[], udid: string, exclude: ReadonlySet<number>): Set<number> {
	const seeds = new Set(rows.filter((r) => r.command.includes(udid)).map((r) => r.pid));
	const all = withDescendants(rows, seeds);
	for (const pid of exclude) all.delete(pid);
	return all;
}

export type TickGroup = { cpuSec: number; rssBytes: number };

export type Tick = {
	/** ms since the sampler started, taken when `ps` returned */
	t: number;
	hostCpuPct: number;
	hostRssBytes: number;
	simCpuPct: number;
	simRssBytes: number;
	/** host CPU seconds since the previous tick (`cpuDeltas`); absent when ps had no `time` column */
	hostCpuSec?: number;
	/** iOS sim CPU seconds since the previous tick; absent on Android (`top` has no cumulative reading here) */
	simCpuSec?: number;
	/** host CPU seconds and RSS per group */
	hostByGroup?: Partial<Record<HostGroup, TickGroup>>;
};

type Point = { t: number; cpu: number; rss: number; cpuSec?: number; groups?: Partial<Record<HostGroup, TickGroup>> };

/**
 * CPU a bench-spawned root's tree used that no tick saw, charged when the root exits: its rusage at exit
 * (`ExecResult.cpuSec`, which includes the descendants it waited for) minus the last `ps time` reading of
 * every process the ticks saw in its tree. `t` is the sampler clock at the exit, `group` the root's group as the
 * ticks gave it (`hostGroupOf` on its row, else its spawn label). The whole charge is booked there, even when
 * descendants of another group (a `bun test` under a `warden` CLI root) used some of it.
 */
export type ExitCharge = { t: number; cpuSec: number; group: HostGroup };

const exitsIn = (exits: readonly ExitCharge[], from: number, to: number): ExitCharge[] =>
	exits.filter((x) => x.t > from && x.t <= to);

/** The part of tick `i`'s interval (previous tick, this tick] inside [from, to], as a fraction of the interval. */
function overlap(points: readonly Point[], i: number, from: number, to: number): number {
	const cur = points[i];
	const prev = points[i - 1];
	if (cur === undefined || prev === undefined || cur.t <= prev.t) return 0;
	const inside = Math.min(cur.t, to) - Math.max(prev.t, from);
	return inside > 0 ? inside / (cur.t - prev.t) : 0;
}

function groupSeries(
	points: readonly Point[],
	inWindow: readonly Point[],
	fractions: readonly number[],
	exits: readonly ExitCharge[]
) {
	const out: Partial<Record<HostGroup, GroupSeries>> = {};
	const names = new Set([
		...points.flatMap((p) => Object.keys(p.groups ?? {}) as HostGroup[]),
		...exits.map((x) => x.group),
	]);
	for (const g of names) {
		const atExit = exits.reduce((a, x) => a + (x.group === g ? x.cpuSec : 0), 0);
		const cpuSeconds = points.reduce((a, p, i) => a + (p.groups?.[g]?.cpuSec ?? 0) * (fractions[i] ?? 0), atExit);
		const rss = inWindow.map((p) => p.groups?.[g]?.rssBytes ?? 0);
		out[g] = {
			cpuSeconds,
			rssAvgBytes: rss.length > 0 ? rss.reduce((a, v) => a + v, 0) / rss.length : 0,
			rssPeakBytes: rss.length > 0 ? Math.max(...rss) : 0,
		};
	}
	return out;
}

/**
 * One `Series` over [from, to]: the `ps %cpu` / RSS figures over the ticks inside it, and CPU seconds
 * prorated per tick interval (a tick's delta covers the time since the previous tick), plus the exit
 * charges inside it (host only; none without tick CPU time). `cpuRatePct` divides by the sampled part of
 * the window.
 */
function series(points: readonly Point[], from: number, to: number, allExits: readonly ExitCharge[] = []): Series {
	const inWindow = points.filter((p) => p.t >= from && p.t <= to);
	const n = inWindow.length;
	const base: Series =
		n === 0
			? { cpuAvgPct: 0, cpuPeakPct: 0, rssAvgBytes: 0, rssPeakBytes: 0, samples: 0 }
			: {
					cpuAvgPct: inWindow.reduce((a, v) => a + v.cpu, 0) / n,
					cpuPeakPct: Math.max(...inWindow.map((v) => v.cpu)),
					rssAvgBytes: inWindow.reduce((a, v) => a + v.rss, 0) / n,
					rssPeakBytes: Math.max(...inWindow.map((v) => v.rss)),
					samples: n,
				};
	if (!points.some((p) => p.cpuSec !== undefined)) return base;
	const fractions = points.map((_, i) => overlap(points, i, from, to));
	const exits = exitsIn(allExits, from, to);
	const atExit = exits.reduce((a, x) => a + x.cpuSec, 0);
	const cpuSeconds = points.reduce((a, p, i) => a + (p.cpuSec ?? 0) * (fractions[i] ?? 0), atExit);
	const first = points[0]?.t ?? 0;
	const last = points.at(-1)?.t ?? 0;
	const sampledMs = Math.min(to, last) - Math.max(from, first);
	const groups = points.some((p) => p.groups !== undefined)
		? groupSeries(points, inWindow, fractions, exits)
		: undefined;
	return {
		...base,
		cpuSeconds,
		...(sampledMs > 0 ? { cpuRatePct: (cpuSeconds / (sampledMs / 1000)) * 100 } : {}),
		...(groups !== undefined ? { byGroup: groups } : {}),
	};
}

const hostPoints = (ticks: readonly Tick[]): Point[] =>
	ticks.map((t) => ({
		t: t.t,
		cpu: t.hostCpuPct,
		rss: t.hostRssBytes,
		...(t.hostCpuSec !== undefined ? { cpuSec: t.hostCpuSec } : {}),
		...(t.hostByGroup !== undefined ? { groups: t.hostByGroup } : {}),
	}));

const simPoints = (ticks: readonly Tick[]): Point[] =>
	ticks.map((t) => ({
		t: t.t,
		cpu: t.simCpuPct,
		rss: t.simRssBytes,
		...(t.simCpuSec !== undefined ? { cpuSec: t.simCpuSec } : {}),
	}));

/** Pure reduction of ticks (and the host's exit charges) to the host and sim `Series` (the whole-framework figures). */
export function summarize(ticks: readonly Tick[], exits: readonly ExitCharge[] = []): { host: Series; sim: Series } {
	return {
		host: series(hostPoints(ticks), Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, exits),
		sim: series(simPoints(ticks), Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY),
	};
}

/**
 * The resources of one window of the sampler clock (a rep's timed `run`); headline = host CPU seconds,
 * absent when no tick had a CPU time (ps without a usable `time` column), never 0.
 */
export function windowSummary(
	ticks: readonly Tick[],
	startMs: number,
	endMs: number,
	exits: readonly ExitCharge[] = []
): RepResources {
	const host = series(hostPoints(ticks), startMs, endMs, exits);
	return {
		window: { startMs, endMs },
		host,
		sim: series(simPoints(ticks), startMs, endMs),
		...(host.cpuSeconds !== undefined ? { cpuSeconds: host.cpuSeconds } : {}),
		rssPeakBytes: host.rssPeakBytes,
	};
}

export type SamplerOptions = {
	exec: Exec;
	rootPids: () => number[];
	/** what the bench spawned each root as (`trackingExec`): the group of a descendant argv does not name */
	rootLabels?: () => ReadonlyMap<number, HostGroup>;
	processPatterns: RegExp[];
	/** restricts pattern matches to processes the bench owns (see `ownerFilter`) */
	owned: (rows: readonly PsRow[]) => readonly PsRow[];
	/** iOS udid or Android serial */
	simUdid?: string;
	platform: Platform;
	intervalMs?: number;
	sink: (tick: Tick) => void;
	/** schedule `fn` every `ms`; returns the canceller (tests capture `fn` and call it by hand) */
	setIntervalFn?: (fn: () => Promise<void>, ms: number) => () => void;
	now?: () => number;
	/** diagnostics (once per sampler: ps answered but no row had a CPU time) */
	log?: (line: string) => void;
};

const ADB_EVERY_MS = 2_000;

function defaultSetInterval(fn: () => Promise<void>, ms: number): () => void {
	const handle = setInterval(() => void fn(), ms);
	return () => clearInterval(handle);
}

type SimReading = { cpuPct: number; rssBytes: number; cpuSec?: number };

async function readAdb(exec: Exec, serial: string): Promise<SimReading | undefined> {
	const r = await exec.run("adb", ["-s", serial, "shell", "top", "-n", "1", "-b"], { timeoutMs: 5_000 });
	if (r.code !== 0) return undefined;
	return androidTotals(parseAdbTop(r.stdout));
}

/** One tick from the host and sim readings; CPU seconds only when ps had a `time` column (Android sim: never). */
function toTick(t: number, h: ReturnType<typeof total>, sim: SimReading, timed: boolean): Tick {
	return {
		t,
		hostCpuPct: h.cpuPct,
		hostRssBytes: h.rssBytes,
		simCpuPct: sim.cpuPct,
		simRssBytes: sim.rssBytes,
		...(timed ? { hostCpuSec: h.cpuSec, hostByGroup: h.byGroup } : {}),
		...(timed && sim.cpuSec !== undefined ? { simCpuSec: sim.cpuSec } : {}),
	};
}

/**
 * Samples host and simulator CPU / RSS every `intervalMs` from one `ps` call per tick (Android adds
 * `adb top` every 2 s, reusing the last reading in between). CPU seconds come from per-pid deltas of the
 * cumulative `time` column (`cpuDeltas`); host rows are split by `HostGroup`. Root pids are read before
 * `ps`, so every registered pid is already running in that snapshot (one registered while ps ran counts
 * only if that snapshot has it), and are checked against their start
 * time (`liveRoots`). Android's `top` rows are matched by name on every read, so no pid is carried over and
 * none can be reused. `elapsed()` is the sampler clock ticks are stamped with; `stop()` waits for an
 * in-flight tick and also returns the ticks and exit charges (for per-rep windows). `exited(pid, cpuSec)`
 * reports a root's CPU time at exit (`trackingExec`): what ps never saw of its tree becomes an
 * `ExitCharge`, settled after any in-flight tick so nothing is charged twice. The caller reports only
 * roots spawned while the sampler runs (an older root's rusage holds CPU from before it).
 */
export function startSampler(options: SamplerOptions): {
	elapsed(): number;
	exited(pid: number, cpuSec: number): void;
	stop(): Promise<{ host: Series; sim: Series; ticks: Tick[]; exits: ExitCharge[] }>;
} {
	const intervalMs = options.intervalMs ?? 500;
	const now = options.now ?? (() => performance.now());
	const schedule = options.setIntervalFn ?? defaultSetInterval;
	const adbEvery = Math.max(1, Math.round(ADB_EVERY_MS / intervalMs));
	const stamps: PidStamps = new Map();
	const readings: CpuReadings = new Map();
	const ticks: Tick[] = [];
	const trees: TreeReadings = new Map();
	const exits: ExitCharge[] = [];
	const rootGroups = new Map<number, HostGroup>();
	const start = now();
	let count = 0;
	let lastAdb: SimReading = { cpuPct: 0, rssBytes: 0 };
	let inflight: Promise<void> = Promise.resolve();
	let stopped = false;
	let stopping = false;
	let untimedLogged = false;
	const noteUntimed = (rows: readonly PsRow[]): void => {
		if (untimedLogged) return;
		untimedLogged = true;
		options.log?.(`sampler: ps answered but no row had a CPU time (${rows.length} rows): no CPU-seconds`);
	};

	const readSim = async (
		rows: readonly PsRow[],
		host: ReadonlySet<number>,
		deltas: ReadonlyMap<number, number>,
		index: number
	): Promise<SimReading> => {
		if (options.simUdid === undefined) return { cpuPct: 0, rssBytes: 0 };
		if (options.platform === "ios") return total(rows, simPids(rows, options.simUdid, host), deltas);
		if (index % adbEvery === 0) lastAdb = (await readAdb(options.exec, options.simUdid)) ?? lastAdb;
		return lastAdb;
	};

	const tick = async (): Promise<void> => {
		if (stopped) return;
		const index = count++;
		const registered = options.rootPids();
		const ps = await options.exec.run("ps", [...PS_ARGS], { timeoutMs: 5_000, env: { ...PS_ENV } });
		if (ps.code !== 0) return;
		const t = now() - start;
		const rows = parsePs(ps.stdout);
		const deltas = cpuDeltas(rows, readings, ticks.length === 0);
		const timed = rows.some((r) => r.cpuTimeSec !== undefined);
		if (!timed) noteUntimed(rows);
		const byPid = new Map(rows.map((r) => [r.pid, r]));
		// a root registered while ps ran and already in its snapshot counts now (its tree is recorded below), so
		// an exit charge never repeats CPU a tick charged; one not in the snapshot waits for the next tick
		const late = options.rootPids().filter((pid) => !registered.includes(pid) && byPid.has(pid));
		const live = liveRoots([...registered, ...late], rows, stamps);
		recordTrees(rows, live, trees);
		const host = hostPids(rows, live, options.processPatterns, options.owned(rows));
		const labels = options.rootLabels?.() ?? new Map<number, HostGroup>();
		for (const pid of live) {
			const row = byPid.get(pid);
			if (row !== undefined) rootGroups.set(pid, hostGroupOf(row, byPid, labels));
		}
		const h = total(rows, host, deltas, (r) => hostGroupOf(r, byPid, labels));
		const out = toTick(t, h, await readSim(rows, host, deltas, index), timed);
		ticks.push(out);
		options.sink(out);
	};

	const cancel = schedule(() => {
		inflight = inflight.then(tick);
		return inflight;
	}, intervalMs);

	const settleExit = (pid: number, cpuSec: number, t: number): void => {
		const seen = [...(trees.get(pid)?.values() ?? [])].reduce((a, v) => a + v, 0);
		trees.delete(pid);
		const group = rootGroups.get(pid) ?? options.rootLabels?.().get(pid) ?? "other";
		rootGroups.delete(pid);
		const unseen = cpuSec - seen;
		if (unseen > 0) exits.push({ t, cpuSec: unseen, group });
	};

	return {
		elapsed: () => now() - start,
		exited(pid, cpuSec) {
			if (stopping) return;
			const t = now() - start;
			inflight = inflight.then(() => settleExit(pid, cpuSec, t));
		},
		async stop() {
			stopping = true;
			cancel();
			await inflight;
			stopped = true;
			return { ...summarize(ticks, exits), ticks: [...ticks], exits: [...exits] };
		},
	};
}
