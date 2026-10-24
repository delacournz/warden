import { type LogEntry, type LogLevel, levelRank } from "./levels";

export type LogFilter = {
	/** keep entries at or above this level */
	minLevel?: LogLevel;
	/** keep entries whose tag or message matches */
	grep?: RegExp;
	/** keep entries at or after this (zone-less) wall clock */
	sinceMs?: number;
};

export function matchesFilter(entry: LogEntry, filter: LogFilter): boolean {
	if (filter.minLevel !== undefined && levelRank(entry.level) < levelRank(filter.minLevel)) return false;
	if (filter.sinceMs !== undefined && entry.tsMs < filter.sinceMs) return false;
	if (filter.grep !== undefined && !filter.grep.test(`${entry.tag}: ${entry.msg}`)) return false;
	return true;
}

/** `--grep` text → RegExp (case-insensitive), or an error message for a bad pattern. */
export function compileGrep(pattern: string): { success: true; data: RegExp } | { success: false; error: string } {
	try {
		return { success: true, data: new RegExp(pattern, "i") };
	} catch (error) {
		return { success: false, error: `--grep: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** Format an entry for text output: the platform's own line shape, so `grep`/`awk` habits carry over. */
export function formatEntry(entry: LogEntry): string {
	return `${entry.ts} ${String(entry.pid).padStart(5)} ${entry.level} ${entry.tag}: ${entry.msg}`;
}
