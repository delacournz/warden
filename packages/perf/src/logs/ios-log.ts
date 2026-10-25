import type { LogEntry, LogLevel } from "./levels";

/** `2026-10-24 10:00:01.123 Df ShopApp[4321:1a2b3c] [subsystem:category] message` (`log stream|show --style compact`). */
const COMPACT =
	/^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d+)(?:[+-]\d{4})?\s+(Db|Df|I|E|Fa|Ft)\s+(.+?)\[(\d+):([0-9a-fA-F]+)\]\s?(.*)$/;

const LEVELS: Record<string, LogLevel> = { Db: "D", Df: "I", I: "I", E: "E", Fa: "F", Ft: "F" };

/** `[subsystem:category] ` at the start of a message. */
const SUBSYSTEM = /^\[([^\]\s]+)\]\s?/;

/** One compact line, or undefined for the `Filtering the log data…` / `Timestamp  Ty Process` headers and continuation lines. */
export function parseCompactLine(line: string): LogEntry | undefined {
	const m = COMPACT.exec(line.replace(/\r$/, ""));
	if (!m) return undefined;
	const [, y, mo, d, h, mi, s, frac, lvl, proc, pid, tid, rest = ""] = m;
	const sub = SUBSYSTEM.exec(rest);
	return {
		ts: `${y}-${mo}-${d} ${h}:${mi}:${s}.${frac}`,
		tsMs: Date.UTC(
			Number(y),
			Number(mo) - 1,
			Number(d),
			Number(h),
			Number(mi),
			Number(s),
			Math.round(Number(`0.${frac}`) * 1000)
		),
		pid: Number(pid),
		tid: Number.parseInt(tid ?? "0", 16),
		level: LEVELS[lvl ?? ""] ?? "I",
		tag: sub?.[1] ?? proc ?? "",
		msg: sub ? rest.slice(sub[0].length) : rest,
	};
}

const quote = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The app's own logs: its subsystem (and sub-subsystems), or anything its executable prints. */
export function iosPredicate(bundleId: string, executable: string): string {
	return [
		`subsystem == ${quote(bundleId)}`,
		`subsystem BEGINSWITH ${quote(bundleId)}`,
		`process == ${quote(executable)}`,
	].join(" OR ");
}

/** argv after `xcrun simctl spawn <udid>` for a live stream. */
export function iosStreamArgv(predicate: string): string[] {
	return ["log", "stream", "--style", "compact", "--level", "info", "--predicate", predicate];
}

/** argv after `xcrun simctl spawn <udid>` for a one-shot read of the last `since` (e.g. `5m`). */
export function iosShowArgv(predicate: string, since: string): string[] {
	return ["log", "show", "--style", "compact", "--info", "--last", since, "--predicate", predicate];
}
