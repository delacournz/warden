import { iosProcessName } from "@delacour/warden-devtools/native-log";
import type { WardenError } from "@delacour/warden-types/error";
import { ok, type Result } from "@delacour/warden-types/result";
import { fail, opError } from "./errors";
import type { OpOutcome, OpSession } from "./session";

/** Severity, lowest first; `level` filters to this one and above. */
export const NATIVE_LEVELS = ["debug", "info", "warn", "error"] as const;
export type NativeLevel = (typeof NATIVE_LEVELS)[number];

/** One line of the app's native log (os_log on iOS, logcat on Android). */
export type NativeLogLine = { ts: number; level: NativeLevel; text: string };

export type NativeLogsParams = {
	/** ms since epoch; default one minute ago */
	since?: number;
	/** this severity and above */
	level?: NativeLevel;
	/** the newest N lines of the window */
	limit?: number;
};

export type NativeLogsResult = { lines: NativeLogLine[] };

const DEFAULT_WINDOW_MS = 60_000;
const READ_TIMEOUT_MS = 15_000;
const FOLLOW_POLL_MS = 1_000;

const severity = (level: NativeLevel): number => NATIVE_LEVELS.indexOf(level);

const IOS_LEVELS: Record<string, NativeLevel> = {
	Debug: "debug",
	Info: "info",
	Default: "info",
	Error: "error",
	Fault: "error",
};

const IOS_TIME = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(?:\.(\d+))?([+-]\d\d)(\d\d)$/;

/** `2026-10-25 12:00:00.123456+1300` (log's ndjson) → ms since epoch. */
function iosTimestamp(raw: string): number | undefined {
	const m = IOS_TIME.exec(raw);
	if (!m) return undefined;
	const [, date, time, fraction = "", hours, minutes] = m;
	const ms = Date.parse(`${date}T${time}.${fraction.slice(0, 3).padEnd(3, "0")}${hours}:${minutes}`);
	return Number.isNaN(ms) ? undefined : ms;
}

/** One `log show --style ndjson` line; anything that is not a log entry (the header, a torn line) is dropped. */
export function parseIosLine(line: string): NativeLogLine | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const row = value as Record<string, unknown>;
	if (typeof row.timestamp !== "string" || typeof row.eventMessage !== "string") return undefined;
	const ts = iosTimestamp(row.timestamp);
	if (ts === undefined) return undefined;
	const level = IOS_LEVELS[typeof row.messageType === "string" ? row.messageType : ""] ?? "info";
	return { ts, level, text: row.eventMessage };
}

const ANDROID_LEVELS: Record<string, NativeLevel> = {
	V: "debug",
	D: "debug",
	I: "info",
	W: "warn",
	E: "error",
	F: "error",
};

const ANDROID_LINE = /^(\d+(?:\.\d+)?)\s+\d+\s+\d+\s+([VDIWEF])\s+(.*?):\s(.*)$/;

/** One `logcat -v threadtime -v epoch` line; the `--- beginning of …` headers and unparsable lines are dropped. */
export function parseAndroidLine(line: string): NativeLogLine | undefined {
	const m = ANDROID_LINE.exec(line);
	if (!m) return undefined;
	const [, seconds, letter, tag, text] = m;
	const ts = Math.round(Number(seconds) * 1000);
	return { ts, level: ANDROID_LEVELS[letter ?? ""] ?? "info", text: `${tag}: ${text}` };
}

function parseLines(platform: "ios" | "android", stdout: string): NativeLogLine[] {
	const parse = platform === "ios" ? parseIosLine : parseAndroidLine;
	const lines: NativeLogLine[] = [];
	for (const raw of stdout.split("\n")) {
		const line = parse(raw);
		if (line) lines.push(line);
	}
	return lines;
}

type Target = { app: string };

function targetOf(session: OpSession): Result<Target, WardenError> {
	const { app } = session.state.read();
	return app === undefined
		? fail(opError("usage", "no app to read native logs of", { hint: "open one first: `session.apps.open({ app })`" }))
		: ok({ app });
}

async function readIos(
	session: OpSession,
	app: string,
	sinceMs: number
): Promise<Result<NativeLogLine[], WardenError>> {
	const { host, device } = session;
	const proc = await iosProcessName({ platform: "ios", udid: device.id, bundleId: app }, host.exec, READ_TIMEOUT_MS);
	if (proc.exe === undefined) return fail(opError("failed", proc.error ?? "unknown process"));
	const seconds = Math.max(1, Math.ceil((host.now() - sinceMs) / 1000));
	const shown = await host.exec(
		[
			"xcrun",
			"simctl",
			"spawn",
			device.id,
			"log",
			"show",
			"--style",
			"ndjson",
			"--last",
			`${seconds}s`,
			"--predicate",
			`process == "${proc.exe}"`,
		],
		{ timeoutMs: READ_TIMEOUT_MS }
	);
	if (shown.exitCode !== 0) {
		return fail(
			opError("failed", `log show: exit ${shown.exitCode} ${shown.stderr.trim().split("\n")[0] ?? ""}`.trim())
		);
	}
	return ok(parseLines("ios", shown.stdout));
}

async function readAndroid(
	session: OpSession,
	app: string,
	sinceMs: number
): Promise<Result<NativeLogLine[], WardenError>> {
	const { host, device } = session;
	const adb = (...args: string[]) => host.exec(["adb", "-s", device.id, ...args], { timeoutMs: READ_TIMEOUT_MS });
	const pid = await adb("shell", "pidof", app);
	const first = pid.stdout.trim().split(/\s+/)[0] ?? "";
	const pidArg = pid.exitCode === 0 && /^\d+$/.test(first) ? [`--pid=${first}`] : [];
	const dump = await adb(
		"logcat",
		"-d",
		"-v",
		"threadtime",
		"-v",
		"epoch",
		...pidArg,
		"-T",
		(sinceMs / 1000).toFixed(3)
	);
	if (dump.exitCode !== 0) {
		return fail(opError("failed", `logcat: exit ${dump.exitCode} ${dump.stderr.trim().split("\n")[0] ?? ""}`.trim()));
	}
	return ok(parseLines("android", dump.stdout));
}

function readSince(session: OpSession, app: string, sinceMs: number): Promise<Result<NativeLogLine[], WardenError>> {
	return session.device.platform === "ios" ? readIos(session, app, sinceMs) : readAndroid(session, app, sinceMs);
}

function filtered(lines: readonly NativeLogLine[], params: NativeLogsParams, sinceMs: number): NativeLogLine[] {
	const min = severity(params.level ?? "debug");
	const kept = lines.filter((l) => l.ts >= sinceMs && severity(l.level) >= min).sort((a, b) => a.ts - b.ts);
	return params.limit === undefined ? kept : kept.slice(-params.limit);
}

/**
 * `nativeLogs`: the app's native log (iOS `simctl spawn log show` for its process, Android `logcat` for its pid) over
 * a window, oldest first. Needs an app (`session.apps.open`) so the process is known.
 */
export async function nativeLogs(session: OpSession, params: NativeLogsParams = {}): OpOutcome<NativeLogsResult> {
	const target = targetOf(session);
	if (!target.success) return target;
	const sinceMs = params.since ?? session.host.now() - DEFAULT_WINDOW_MS;
	const read = await readSince(session, target.data.app, sinceMs);
	if (!read.success) return read;
	const lines = filtered(read.data, params, sinceMs);
	return ok({ result: { lines }, text: lines.map((l) => `${l.level} ${l.text}`).join("\n") });
}

const lineKey = (line: NativeLogLine): string => `${line.ts}\u0000${line.text}`;

/**
 * `nativeLogs` with `follow`: batches of new lines, polled once a second until `signal` aborts (the stream then ends
 * without an error). A read that fails is yielded once as a failed result and ends the stream. `limit` applies to the
 * first batch only.
 */
export async function* followNativeLogs(
	session: OpSession,
	params: NativeLogsParams,
	signal: AbortSignal | undefined
): AsyncGenerator<Result<NativeLogLine[], WardenError>, void, void> {
	const target = targetOf(session);
	if (!target.success) {
		yield target;
		return;
	}
	let cursor: Cursor = { ts: params.since ?? session.host.now() - DEFAULT_WINDOW_MS, seen: new Set() };
	let batchParams = params;
	const stopped = (): boolean => signal?.aborted === true;
	while (!stopped()) {
		const read = await readSince(session, target.data.app, cursor.ts);
		if (!read.success) {
			if (!stopped()) yield read;
			return;
		}
		const seenBefore = cursor.seen;
		const fresh = filtered(read.data, batchParams, cursor.ts).filter((l) => !seenBefore.has(lineKey(l)));
		batchParams = { ...params, limit: undefined };
		cursor = advance(cursor, read.data);
		if (fresh.length > 0) yield ok(fresh);
		if (!(await napped(session))) return;
	}
}

/** Where the next poll starts (the newest line's time) and which lines at exactly that time were already yielded. */
type Cursor = { ts: number; seen: Set<string> };

function advance(cursor: Cursor, lines: readonly NativeLogLine[]): Cursor {
	const ts = lines.reduce((max, l) => Math.max(max, l.ts), cursor.ts);
	const seen = ts > cursor.ts ? new Set<string>() : new Set(cursor.seen);
	for (const line of lines) if (line.ts === ts) seen.add(lineKey(line));
	return { ts, seen };
}

/** Wait one poll interval; `false` when the wait was cancelled (an aborted session sleep rejects). */
async function napped(session: OpSession): Promise<boolean> {
	try {
		await session.host.sleep(FOLLOW_POLL_MS);
		return true;
	} catch {
		return false;
	}
}
