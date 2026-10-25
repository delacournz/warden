export const LOG_LEVELS = ["V", "D", "I", "W", "E", "F"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** One device log line, platform-neutral. `tsMs` is the line's wall clock read as if it were UTC (no zone on either platform's text). */
export type LogEntry = {
	/** as printed: `10-24 10:00:01.123` (Android) / `2026-10-24 10:00:01.123` (iOS) */
	ts: string;
	tsMs: number;
	pid: number;
	tid: number;
	level: LogLevel;
	tag: string;
	msg: string;
};

/** `error`, `E`, `warn`… → level; undefined when unknown. */
export function parseLevel(raw: string): LogLevel | undefined {
	const first = raw.trim().charAt(0).toUpperCase();
	return (LOG_LEVELS as readonly string[]).includes(first) ? (first as LogLevel) : undefined;
}

export const levelRank = (level: LogLevel): number => LOG_LEVELS.indexOf(level);
