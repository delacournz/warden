import { type LogEntry, type LogLevel, parseLevel } from "./levels";

/** `MM-DD HH:MM:SS.mmm  PID  TID L TAG: message` (`logcat -v threadtime`). Tags can hold spaces and the colon is padded. */
const THREADTIME = /^(\d\d)-(\d\d)\s+(\d\d):(\d\d):(\d\d)\.(\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+(.*?)\s*:\s?(.*)$/;

/** One `logcat -v threadtime` line, or undefined for buffer headers (`--------- beginning of main`) and noise. `year` completes the zone-less stamp. */
export function parseThreadtime(line: string, year: number): LogEntry | undefined {
	const m = THREADTIME.exec(line.replace(/\r$/, ""));
	if (!m) return undefined;
	const [, mo, d, h, mi, s, ms, pid, tid, lvl, tag, msg] = m;
	const level: LogLevel = lvl === "S" ? "F" : (parseLevel(lvl ?? "") ?? "I");
	return {
		ts: `${mo}-${d} ${h}:${mi}:${s}.${ms}`,
		tsMs: Date.UTC(year, Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms)),
		pid: Number(pid),
		tid: Number(tid),
		level,
		tag: tag ?? "",
		msg: msg ?? "",
	};
}

/** `adb shell date '+%Y-%m-%d %H:%M:%S'` → the device's zone-less wall clock in ms (logcat stamps are in the same zone). */
export function parseDeviceDate(text: string): number | undefined {
	const m = /(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/.exec(text);
	if (!m) return undefined;
	const [, y, mo, d, h, mi, s] = m.map(Number);
	return Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, h, mi, s);
}

/** `logcat` argv (after `adb -s <serial>`) for one app: live stream, or the last `tail` lines. */
export function logcatArgv(pid: number, opts: { tail?: number } = {}): string[] {
	return opts.tail === undefined
		? ["logcat", "-v", "threadtime", "--pid", String(pid)]
		: ["logcat", "-d", "-v", "threadtime", "--pid", String(pid), "-t", String(opts.tail)];
}
