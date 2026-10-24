export type PsRow = {
	pid: number;
	ppid: number;
	rssKb: number;
	cpuPct: number;
	/** cumulative CPU time (user + system) in seconds, from the `time` column when ps was asked for it */
	cpuTimeSec?: number;
	/** `lstart` (`Fri Oct 16 12:07:31 2026`) when ps was asked for it; identifies the process behind a pid */
	startedAt?: string;
	command: string;
};

const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/;
const LSTART = String.raw`[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}`;
const PS_ROW_STARTED = new RegExp(String.raw`^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(${LSTART})\s+(.*)$`);
const CPU_TIME = String.raw`(?:\d+-)?\d+(?::\d+)+(?:\.\d+)?`;
const PS_ROW_TIMED = new RegExp(String.raw`^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(${CPU_TIME})\s+(${LSTART})\s+(.*)$`);
/** A data line of the `time` + `lstart` layout whatever its `time` token looks like (only the columns are trusted). */
const PS_ROW_TIMED_ANY = new RegExp(String.raw`^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(${LSTART})\s+(.*)$`);
/** The header of `ps -o …,time,lstart,command` (`TIME` and `STARTED` columns). */
const TIMED_HEADER = /^\s*PID\b.*\bTIME\b.*\bSTARTED\b/;

/**
 * The sampler's ps invocation: `time` (cumulative CPU time, the only rate-safe CPU figure: `%cpu` is a
 * decaying average on macOS) and `lstart` sit before `command` so the command stays the last, free-form column.
 */
export const PS_ARGS: readonly string[] = ["-axo", "pid,ppid,rss,%cpu,time,lstart,command"];

/**
 * The sampler's ps environment: `lstart` is local time, so a DST change mid-run would shift every start
 * time and make every pid look new (whole lifetimes charged, every root dropped); UTC never shifts.
 * The C locale keeps the `lstart` names English and the decimal point a dot, as the regexes expect.
 */
export const PS_ENV: Readonly<Record<string, string>> = { TZ: "UTC", LC_ALL: "C" };

/**
 * `ps time` to seconds: macOS prints `M:SS.ss` (10 ms resolution, minutes unbounded), procps
 * `[DD-]HH:MM:SS` (whole seconds: on a Linux host a 500 ms tick's delta is 0 or 1 s, only sums mean
 * anything). Undefined for anything else.
 */
export function parseCpuTime(text: string): number | undefined {
	const m = /^(?:(\d+)-)?(\d+(?::\d+)+(?:\.\d+)?)$/.exec(text.trim());
	if (m === null || m[2] === undefined) return undefined;
	const days = Number(m[1] ?? 0);
	const seconds = m[2].split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
	return days * 86_400 + seconds;
}

/**
 * Parses `ps -axo pid,ppid,rss,%cpu,command`, the same with an `lstart` column before `command` (then
 * `startedAt` is set), or with `time` and `lstart` (then `cpuTimeSec` is set too). The header and
 * unparsable lines are skipped. When the header names `TIME` and `STARTED`, every data line is read in
 * that layout only: a `time` value `parseCpuTime` does not know leaves `cpuTimeSec` unset but keeps the
 * row's start time and command (the legacy regexes would read the time and start into the command).
 */
export function parsePs(text: string): PsRow[] {
	const lines = text.split("\n");
	if (lines.some((l) => TIMED_HEADER.test(l))) return lines.flatMap((l) => parseTimedLayoutRow(l) ?? []);
	const rows: PsRow[] = [];
	for (const line of lines) {
		const timed = parseTimedRow(line);
		if (timed !== undefined) {
			rows.push(timed);
			continue;
		}
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

/** A row of `ps -axo pid,ppid,rss,%cpu,time,lstart,command`, else undefined. */
function parseTimedRow(line: string): PsRow | undefined {
	const m = PS_ROW_TIMED.exec(line);
	const cpuTimeSec = m === null ? undefined : parseCpuTime(m[5] ?? "");
	if (m === null || cpuTimeSec === undefined) return undefined;
	return {
		pid: Number(m[1]),
		ppid: Number(m[2]),
		rssKb: Number(m[3]),
		cpuPct: Number(m[4]),
		cpuTimeSec,
		startedAt: m[6] ?? "",
		command: m[7] ?? "",
	};
}

/** A data line of the `time` + `lstart` layout; `cpuTimeSec` only when the `time` token parses. */
function parseTimedLayoutRow(line: string): PsRow | undefined {
	const m = PS_ROW_TIMED_ANY.exec(line);
	if (m === null) return undefined;
	const cpuTimeSec = parseCpuTime(m[5] ?? "");
	return {
		pid: Number(m[1]),
		ppid: Number(m[2]),
		rssKb: Number(m[3]),
		cpuPct: Number(m[4]),
		...(cpuTimeSec !== undefined ? { cpuTimeSec } : {}),
		startedAt: m[6] ?? "",
		command: m[7] ?? "",
	};
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

/** The last cumulative CPU reading per pid (every process of the snapshot, so a process joining the set later is charged only its delta). */
export type CpuReadings = Map<number, { startedAt?: string; sec: number }>;

/**
 * CPU seconds each process used since the previous snapshot, and `prev` replaced by this snapshot's readings.
 * On the `baseline` snapshot every delta is 0 (what a process used before the sampler started is not the
 * framework's). A pid missing from the previous snapshot, a pid whose start time changed (reused), or a
 * reading that went down is a process born since then: all its CPU time is charged. A process that died
 * since the previous snapshot drops out; its CPU up to its last reading was charged to the earlier ticks
 * (what it used after that, and processes that live entirely between two ticks, are not seen here; for
 * the children the bench runs, the sampler's `ExitCharge` adds it back from their rusage at exit).
 */
export function cpuDeltas(rows: readonly PsRow[], prev: CpuReadings, baseline: boolean): Map<number, number> {
	const out = new Map<number, number>();
	const next: CpuReadings = new Map();
	for (const r of rows) {
		if (r.cpuTimeSec === undefined) continue;
		next.set(r.pid, { ...(r.startedAt !== undefined ? { startedAt: r.startedAt } : {}), sec: r.cpuTimeSec });
		const before = prev.get(r.pid);
		const same = before !== undefined && before.startedAt === r.startedAt && r.cpuTimeSec >= before.sec;
		out.set(r.pid, baseline ? 0 : same ? r.cpuTimeSec - before.sec : r.cpuTimeSec);
	}
	prev.clear();
	for (const [pid, reading] of next) prev.set(pid, reading);
	return out;
}
