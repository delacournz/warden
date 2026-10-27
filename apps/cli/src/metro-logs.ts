import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { type AsyncResult, ok, type Result } from "@delacour/warden-types/result";
import { type DevSessionDeps, type DevSessionError, findDevSession } from "./dev-session";
import { METRO_LOG_KINDS, type MetroLogEntry, type MetroLogKind, parseMetroLog } from "./dev-tui/metro-log";

/** Only the end of `metro.log` is read: a long session writes megabytes of progress redraws. */
export const MAX_METRO_LOG_BYTES = 8 * 1024 * 1024;

export type MetroLogsErrorCode = DevSessionError["code"] | "metro_log_unavailable" | "invalid_query";

export type MetroLogsError = { code: MetroLogsErrorCode; message: string; hint?: string };

/** What `warden dev logs` and the MCP server ask for. Every field narrows. */
export type MetroLogQuery = {
	/** device id of the session; omit when only one is running */
	udid?: string;
	projectRoot?: string;
	/** keep entries stamped at or after this epoch ms; entries without a time pass (see `readMetroLogs`) */
	sinceMs?: number;
	/** the last N entries after every other filter */
	tail?: number;
	/** regexp source, matched case-insensitively against each entry's text */
	grep?: string;
	kinds?: readonly MetroLogKind[];
};

export type MetroLogDeps = DevSessionDeps;

type Env = Record<string, string | undefined>;

/** The error for a session with no `metro.log` (non-TUI modes don't record it). */
export const metroLogUnavailable = (logDir: string): MetroLogsError => ({
	code: "metro_log_unavailable",
	message: `no Metro log at ${join(logDir, "metro.log")}`,
	hint: "Metro output is only recorded by the `warden dev` dashboard (a terminal, no --no-tui / --json); run it there",
});

/** The tail of `path` (at most `MAX_METRO_LOG_BYTES`), cut to whole lines, with the file's size and mtime. */
export function readMetroLogText(path: string): { text: string; size: number; mtimeMs: number } | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const { size, mtimeMs } = statSync(path);
		const start = Math.max(0, size - MAX_METRO_LOG_BYTES);
		const buffer = Buffer.alloc(size - start);
		readSync(fd, buffer, 0, buffer.length, start);
		let text = buffer.toString("utf8");
		if (start > 0) text = text.slice(text.indexOf("\n") + 1);
		const lastNewline = text.lastIndexOf("\n");
		return { text: lastNewline === -1 ? "" : text.slice(0, lastNewline + 1), size, mtimeMs };
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Narrow entries by kind, grep, time and tail. A bad `grep` is an `invalid_query` error. */
export function filterMetroLogs(
	entries: readonly MetroLogEntry[],
	query: Omit<MetroLogQuery, "udid" | "projectRoot">
): Result<MetroLogEntry[], MetroLogsError> {
	let pattern: RegExp | undefined;
	if (query.grep !== undefined) {
		try {
			pattern = new RegExp(query.grep, "i");
		} catch {
			return { success: false, error: { code: "invalid_query", message: `invalid --grep regexp: ${query.grep}` } };
		}
	}
	const { kinds, sinceMs, tail } = query;
	const kept = entries.filter(
		(e) =>
			(kinds === undefined || kinds.length === 0 || kinds.includes(e.kind)) &&
			(pattern === undefined || pattern.test(e.text)) &&
			(sinceMs === undefined || e.ts === undefined || e.ts >= sinceMs)
	);
	return ok(tail === undefined ? kept : tail <= 0 ? [] : kept.slice(-tail));
}

/** `kinds` from a comma list (`error,bundle_failed`); an unknown name is an `invalid_query` error. */
export function parseMetroLogKinds(list: string): Result<MetroLogKind[], MetroLogsError> {
	const kinds: MetroLogKind[] = [];
	for (const name of list
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "")) {
		const kind = METRO_LOG_KINDS.find((k) => k === name);
		if (kind === undefined) {
			return {
				success: false,
				error: {
					code: "invalid_query",
					message: `unknown kind "${name}"`,
					hint: `one of ${METRO_LOG_KINDS.join(", ")}`,
				},
			};
		}
		kinds.push(kind);
	}
	return ok(kinds);
}

/**
 * The Metro output of a running `warden dev` session, classified and filtered. Shared by `warden dev logs` and the
 * MCP server. `metro.log` carries no per-line times, so `sinceMs` can only rule the whole file out: when it was last
 * written before `sinceMs` nothing in it is newer.
 */
export function readMetroLogs(
	env: Env,
	query: MetroLogQuery = {},
	deps?: MetroLogDeps
): Result<MetroLogEntry[], MetroLogsError> {
	const session = findDevSession(
		env,
		{
			...(query.udid === undefined ? {} : { udid: query.udid }),
			...(query.projectRoot === undefined ? {} : { projectRoot: query.projectRoot }),
		},
		deps
	);
	if (!session.success) return session;
	const log = readMetroLogText(join(session.data.logDir, "metro.log"));
	if (log === undefined) return { success: false, error: metroLogUnavailable(session.data.logDir) };
	if (query.sinceMs !== undefined && log.mtimeMs < query.sinceMs) return ok([]);
	return filterMetroLogs(parseMetroLog(log.text), query);
}

/** Entries with a trailing error block still being written are held back until the log stops growing. */
const holdsOpenBlock = (entry: MetroLogEntry | undefined): boolean =>
	entry !== undefined && (entry.kind === "bundle_failed" || entry.kind === "error");

export type MetroLogFollowDeps = {
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	signal: AbortSignal;
	pollMs?: number;
};

/**
 * Polls `<logDir>/metro.log` and hands `onEntries` every new entry (stamped with the time it was seen) until `signal`
 * aborts. Starts after what is already in the file; use `readMetroLogs` for that. A truncated file starts over.
 */
export async function followMetroLog(
	logDir: string,
	query: Omit<MetroLogQuery, "udid" | "projectRoot" | "tail">,
	deps: MetroLogFollowDeps,
	onEntries: (entries: MetroLogEntry[]) => void
): AsyncResult<void, MetroLogsError> {
	const path = join(logDir, "metro.log");
	const first = readMetroLogText(path);
	if (first === undefined) return { success: false, error: metroLogUnavailable(logDir) };
	const cursor = { seen: parseMetroLog(first.text).length, size: first.size };
	while (!deps.signal.aborted) {
		await deps.sleep(deps.pollMs ?? 500);
		if (deps.signal.aborted) break;
		const fresh = pollFresh(path, cursor, deps.now());
		if (fresh.length === 0) continue;
		const filtered = filterMetroLogs(fresh, query);
		if (!filtered.success) return filtered;
		if (filtered.data.length > 0) onEntries(filtered.data);
	}
	return ok(undefined);
}

/** One poll: the entries past `cursor.seen` (stamped `now`), advancing the cursor. */
function pollFresh(path: string, cursor: { seen: number; size: number }, now: number): MetroLogEntry[] {
	const next = readMetroLogText(path);
	if (next === undefined) return [];
	const grew = next.size !== cursor.size;
	if (next.size < cursor.size) cursor.seen = 0;
	cursor.size = next.size;
	const all = parseMetroLog(next.text);
	const upTo = grew && holdsOpenBlock(all[all.length - 1]) ? all.length - 1 : all.length;
	if (upTo <= cursor.seen) return [];
	const fresh = all.slice(cursor.seen, upTo).map((e) => ({ ...e, ts: e.ts ?? now }));
	cursor.seen = upTo;
	return fresh;
}
