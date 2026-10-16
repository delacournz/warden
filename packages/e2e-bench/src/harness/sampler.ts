import type { Platform, Series } from "../results/schema";
import type { Exec } from "./exec";

export type PsRow = {
	pid: number;
	ppid: number;
	rssKb: number;
	cpuPct: number;
	/** `lstart` (`Fri Oct 16 12:07:31 2026`) when ps was asked for it; identifies the process behind a pid */
	startedAt?: string;
	command: string;
};

const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/;
const LSTART = String.raw`[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}`;
const PS_ROW_STARTED = new RegExp(String.raw`^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(${LSTART})\s+(.*)$`);

/** The sampler's ps invocation: `lstart` sits before `command` so the command stays the last, free-form column. */
export const PS_ARGS: readonly string[] = ["-axo", "pid,ppid,rss,%cpu,lstart,command"];

/**
 * Parses `ps -axo pid,ppid,rss,%cpu,command`, or the same with an `lstart` column before `command`
 * (then `startedAt` is set). The header and unparsable lines are skipped.
 */
export function parsePs(text: string): PsRow[] {
	const rows: PsRow[] = [];
	for (const line of text.split("\n")) {
		const started = PS_ROW_STARTED.exec(line);
		if (started !== null) {
			rows.push({
				pid: Number(started[1]),
				ppid: Number(started[2]),
				rssKb: Number(started[3]),
				cpuPct: Number(started[4]),
				startedAt: started[5] ?? "",
				command: started[6] ?? "",
			});
			continue;
		}
		const m = PS_ROW.exec(line);
		if (m === null) continue;
		rows.push({
			pid: Number(m[1]),
			ppid: Number(m[2]),
			rssKb: Number(m[3]),
			cpuPct: Number(m[4]),
			command: m[5] ?? "",
		});
	}
	return rows;
}

export type AdbTopRow = { pid: number; rssBytes: number; cpuPct: number; name: string };

const TOP_ROW = /^\s*(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+(\S+)\s+\S+\s+\S\s+([\d.]+)\s+[\d.]+\s+\S+\s+(.*)$/;
const UNITS: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** `250M` → bytes; a bare number is kilobytes (toybox top prints RES in K when no suffix). */
function parseSize(text: string): number {
	const m = /^([\d.]+)([KMGT]?)$/.exec(text);
	if (m === null) return 0;
	return Math.round(Number(m[1]) * (UNITS[m[2] ?? ""] ?? 1024));
}

/** Parses `adb shell top -n 1 -b` process rows (toybox layout: PID USER PR NI VIRT RES SHR S %CPU %MEM TIME+ ARGS). */
export function parseAdbTop(text: string): AdbTopRow[] {
	const rows: AdbTopRow[] = [];
	for (const line of text.split("\n")) {
		const m = TOP_ROW.exec(line);
		if (m === null) continue;
		rows.push({ pid: Number(m[1]), rssBytes: parseSize(m[2] ?? ""), cpuPct: Number(m[3]), name: m[4] ?? "" });
	}
	return rows;
}

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

/** `seeds` plus every transitive child (by ppid). */
export function withDescendants(rows: readonly PsRow[], seeds: ReadonlySet<number>): Set<number> {
	const children = new Map<number, number[]>();
	for (const r of rows) children.set(r.ppid, [...(children.get(r.ppid) ?? []), r.pid]);
	const out = new Set<number>();
	const stack = [...seeds];
	while (stack.length > 0) {
		const pid = stack.pop();
		if (pid === undefined || out.has(pid)) continue;
		out.add(pid);
		stack.push(...(children.get(pid) ?? []));
	}
	return out;
}

function total(rows: readonly PsRow[], pids: ReadonlySet<number>): { cpuPct: number; rssBytes: number } {
	let cpuPct = 0;
	let rssKb = 0;
	for (const r of rows) {
		if (!pids.has(r.pid)) continue;
		cpuPct += r.cpuPct;
		rssKb += r.rssKb;
	}
	return { cpuPct, rssBytes: rssKb * 1024 };
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

export type Tick = { t: number; hostCpuPct: number; hostRssBytes: number; simCpuPct: number; simRssBytes: number };

function series(values: readonly { cpu: number; rss: number }[]): Series {
	if (values.length === 0) return { cpuAvgPct: 0, cpuPeakPct: 0, rssAvgBytes: 0, rssPeakBytes: 0, samples: 0 };
	const n = values.length;
	return {
		cpuAvgPct: values.reduce((a, v) => a + v.cpu, 0) / n,
		cpuPeakPct: Math.max(...values.map((v) => v.cpu)),
		rssAvgBytes: values.reduce((a, v) => a + v.rss, 0) / n,
		rssPeakBytes: Math.max(...values.map((v) => v.rss)),
		samples: n,
	};
}

/** Pure reduction of ticks to the host and sim `Series`. */
export function summarize(ticks: readonly Tick[]): { host: Series; sim: Series } {
	return {
		host: series(ticks.map((t) => ({ cpu: t.hostCpuPct, rss: t.hostRssBytes }))),
		sim: series(ticks.map((t) => ({ cpu: t.simCpuPct, rss: t.simRssBytes }))),
	};
}

export type SamplerOptions = {
	exec: Exec;
	rootPids: () => number[];
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
};

const ADB_EVERY_MS = 2_000;

function defaultSetInterval(fn: () => Promise<void>, ms: number): () => void {
	const handle = setInterval(() => void fn(), ms);
	return () => clearInterval(handle);
}

type SimReading = { cpuPct: number; rssBytes: number };

async function readAdb(exec: Exec, serial: string): Promise<SimReading | undefined> {
	const r = await exec.run("adb", ["-s", serial, "shell", "top", "-n", "1", "-b"], { timeoutMs: 5_000 });
	if (r.code !== 0) return undefined;
	return androidTotals(parseAdbTop(r.stdout));
}

/**
 * Samples host and simulator CPU / RSS every `intervalMs` from one `ps` call per tick (Android adds
 * `adb top` every 2 s, reusing the last reading in between). Root pids are read before `ps`, so every
 * registered pid is already running in that snapshot, and are checked against their start time
 * (`liveRoots`). Android's `top` rows are matched by name on every read, so no pid is carried over and
 * none can be reused. `stop()` waits for an in-flight tick.
 */
export function startSampler(options: SamplerOptions): { stop(): Promise<{ host: Series; sim: Series }> } {
	const intervalMs = options.intervalMs ?? 500;
	const now = options.now ?? (() => performance.now());
	const schedule = options.setIntervalFn ?? defaultSetInterval;
	const adbEvery = Math.max(1, Math.round(ADB_EVERY_MS / intervalMs));
	const stamps: PidStamps = new Map();
	const ticks: Tick[] = [];
	const start = now();
	let count = 0;
	let lastAdb: SimReading = { cpuPct: 0, rssBytes: 0 };
	let inflight: Promise<void> = Promise.resolve();
	let stopped = false;

	const tick = async (): Promise<void> => {
		if (stopped) return;
		const index = count++;
		const registered = options.rootPids();
		const ps = await options.exec.run("ps", [...PS_ARGS], { timeoutMs: 5_000 });
		if (ps.code !== 0) return;
		const rows = parsePs(ps.stdout);
		const host = hostPids(rows, liveRoots(registered, rows, stamps), options.processPatterns, options.owned(rows));
		const h = total(rows, host);
		let sim: SimReading = { cpuPct: 0, rssBytes: 0 };
		if (options.platform === "ios" && options.simUdid !== undefined) {
			sim = total(rows, simPids(rows, options.simUdid, host));
		} else if (options.platform === "android" && options.simUdid !== undefined) {
			if (index % adbEvery === 0) lastAdb = (await readAdb(options.exec, options.simUdid)) ?? lastAdb;
			sim = lastAdb;
		}
		const out: Tick = {
			t: now() - start,
			hostCpuPct: h.cpuPct,
			hostRssBytes: h.rssBytes,
			simCpuPct: sim.cpuPct,
			simRssBytes: sim.rssBytes,
		};
		ticks.push(out);
		options.sink(out);
	};

	const cancel = schedule(() => {
		inflight = inflight.then(tick);
		return inflight;
	}, intervalMs);

	return {
		async stop() {
			cancel();
			await inflight;
			stopped = true;
			return summarize(ticks);
		},
	};
}
