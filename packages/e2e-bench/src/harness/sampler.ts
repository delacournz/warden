import type { Platform, Series } from "../results/schema";
import type { Exec } from "./exec";

export type PsRow = { pid: number; ppid: number; rssKb: number; cpuPct: number; command: string };

const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/;

/** Parses `ps -axo pid,ppid,rss,%cpu,command`; the header and unparsable lines are skipped. */
export function parsePs(text: string): PsRow[] {
	const rows: PsRow[] = [];
	for (const line of text.split("\n")) {
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

const ANDROID_TARGET = /nz\.co\.delacour\.warden\.example|uiautomator|instrumentation/;

/** Total CPU% and RSS of the app and the instrumentation / uiautomator processes. */
export function androidTotals(rows: readonly AdbTopRow[]): { cpuPct: number; rssBytes: number } {
	let cpuPct = 0;
	let rssBytes = 0;
	for (const r of rows) {
		if (!ANDROID_TARGET.test(r.name)) continue;
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
 * `adb top` every 2 s, reusing the last reading in between). `stop()` waits for an in-flight tick.
 */
export function startSampler(options: SamplerOptions): { stop(): Promise<{ host: Series; sim: Series }> } {
	const intervalMs = options.intervalMs ?? 500;
	const now = options.now ?? (() => performance.now());
	const schedule = options.setIntervalFn ?? defaultSetInterval;
	const adbEvery = Math.max(1, Math.round(ADB_EVERY_MS / intervalMs));
	const ticks: Tick[] = [];
	const start = now();
	let count = 0;
	let lastAdb: SimReading = { cpuPct: 0, rssBytes: 0 };
	let inflight: Promise<void> = Promise.resolve();
	let stopped = false;

	const tick = async (): Promise<void> => {
		if (stopped) return;
		const index = count++;
		const ps = await options.exec.run("ps", ["-axo", "pid,ppid,rss,%cpu,command"], { timeoutMs: 5_000 });
		if (ps.code !== 0) return;
		const rows = parsePs(ps.stdout);
		const host = hostPids(rows, options.rootPids(), options.processPatterns, options.owned(rows));
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
