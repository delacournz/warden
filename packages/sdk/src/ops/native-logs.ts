import { IosProcessName } from "@delacour/warden-devtools/native-log";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { opErrors } from "./errors";
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

const IOS_LEVELS: Record<string, NativeLevel> = {
	Debug: "debug",
	Info: "info",
	Default: "info",
	Error: "error",
	Fault: "error",
};

const IOS_TIME = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(?:\.(\d+))?([+-]\d\d)(\d\d)$/;

const ANDROID_LEVELS: Record<string, NativeLevel> = {
	V: "debug",
	D: "debug",
	I: "info",
	W: "warn",
	E: "error",
	F: "error",
};

const ANDROID_LINE = /^(\d+(?:\.\d+)?)\s+\d+\s+\d+\s+([VDIWEF])\s+(.*?):\s(.*)$/;

type Target = { app: string };

/** Where the next poll starts (the newest line's time) and which lines at exactly that time were already yielded. */
type Cursor = { ts: number; seen: Set<string> };

export class NativeLogOps {
	private severity(level: NativeLevel): number {
		return NATIVE_LEVELS.indexOf(level);
	}

	/** `2026-10-25 12:00:00.123456+1300` (log's ndjson) → ms since epoch. */
	private iosTimestamp(raw: string): number | undefined {
		const m = IOS_TIME.exec(raw);
		if (!m) return undefined;
		const [, date, time, fraction = "", hours, minutes] = m;
		const ms = Date.parse(`${date}T${time}.${fraction.slice(0, 3).padEnd(3, "0")}${hours}:${minutes}`);
		return Number.isNaN(ms) ? undefined : ms;
	}

	/** One `log show --style ndjson` line; anything that is not a log entry (the header, a torn line) is dropped. */
	parseIosLine(line: string): NativeLogLine | undefined {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			return undefined;
		}
		if (typeof value !== "object" || value === null) return undefined;
		const row = value as Record<string, unknown>;
		if (typeof row.timestamp !== "string" || typeof row.eventMessage !== "string") return undefined;
		const ts = this.iosTimestamp(row.timestamp);
		if (ts === undefined) return undefined;
		const level = IOS_LEVELS[typeof row.messageType === "string" ? row.messageType : ""] ?? "info";
		return { ts, level, text: row.eventMessage };
	}

	/** One `logcat -v threadtime -v epoch` line; the `--- beginning of …` headers and unparsable lines are dropped. */
	parseAndroidLine(line: string): NativeLogLine | undefined {
		const m = ANDROID_LINE.exec(line);
		if (!m) return undefined;
		const [, seconds, letter, tag, text] = m;
		const ts = Math.round(Number(seconds) * 1000);
		return { ts, level: ANDROID_LEVELS[letter ?? ""] ?? "info", text: `${tag}: ${text}` };
	}

	private parseLines(platform: "ios" | "android", stdout: string): NativeLogLine[] {
		const parse = (raw: string): NativeLogLine | undefined =>
			platform === "ios" ? this.parseIosLine(raw) : this.parseAndroidLine(raw);
		const lines: NativeLogLine[] = [];
		for (const raw of stdout.split("\n")) {
			const line = parse(raw);
			if (line) lines.push(line);
		}
		return lines;
	}

	private targetOf(session: OpSession): Result<Target, WardenError> {
		const { app } = session.state.read();
		return app === undefined
			? opErrors.fail(
					opErrors.opError("usage", "no app to read native logs of", {
						hint: "open one first: `session.apps.open({ app })`",
					})
				)
			: resultFactory.ok({ app });
	}

	private async readIos(
		session: OpSession,
		app: string,
		sinceMs: number
	): Promise<Result<NativeLogLine[], WardenError>> {
		const { host, device } = session;
		const proc = await new IosProcessName(host.exec).of(
			{ platform: "ios", udid: device.id, bundleId: app },
			READ_TIMEOUT_MS
		);
		if (proc.exe === undefined) return opErrors.fail(opErrors.opError("failed", proc.error ?? "unknown process"));
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
			return opErrors.fail(
				opErrors.opError(
					"failed",
					`log show: exit ${shown.exitCode} ${shown.stderr.trim().split("\n")[0] ?? ""}`.trim()
				)
			);
		}
		return resultFactory.ok(this.parseLines("ios", shown.stdout));
	}

	private async readAndroid(
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
			return opErrors.fail(
				opErrors.opError("failed", `logcat: exit ${dump.exitCode} ${dump.stderr.trim().split("\n")[0] ?? ""}`.trim())
			);
		}
		return resultFactory.ok(this.parseLines("android", dump.stdout));
	}

	private readSince(session: OpSession, app: string, sinceMs: number): Promise<Result<NativeLogLine[], WardenError>> {
		return session.device.platform === "ios"
			? this.readIos(session, app, sinceMs)
			: this.readAndroid(session, app, sinceMs);
	}

	private filtered(lines: readonly NativeLogLine[], params: NativeLogsParams, sinceMs: number): NativeLogLine[] {
		const min = this.severity(params.level ?? "debug");
		const kept = lines.filter((l) => l.ts >= sinceMs && this.severity(l.level) >= min).sort((a, b) => a.ts - b.ts);
		return params.limit === undefined ? kept : kept.slice(-params.limit);
	}

	/**
	 * `nativeLogs`: the app's native log (iOS `simctl spawn log show` for its process, Android `logcat` for its pid) over
	 * a window, oldest first. Needs an app (`session.apps.open`) so the process is known.
	 */
	async nativeLogs(session: OpSession, params: NativeLogsParams = {}): OpOutcome<NativeLogsResult> {
		const target = this.targetOf(session);
		if (!target.success) return target;
		const sinceMs = params.since ?? session.host.now() - DEFAULT_WINDOW_MS;
		const read = await this.readSince(session, target.data.app, sinceMs);
		if (!read.success) return read;
		const lines = this.filtered(read.data, params, sinceMs);
		return resultFactory.ok({ result: { lines }, text: lines.map((l) => `${l.level} ${l.text}`).join("\n") });
	}

	private lineKey(line: NativeLogLine): string {
		return `${line.ts}\u0000${line.text}`;
	}

	/**
	 * `nativeLogs` with `follow`: batches of new lines, polled once a second until `signal` aborts (the stream then ends
	 * without an error). A read that fails is yielded once as a failed result and ends the stream. `limit` applies to the
	 * first batch only.
	 */
	async *followNativeLogs(
		session: OpSession,
		params: NativeLogsParams,
		signal: AbortSignal | undefined
	): AsyncGenerator<Result<NativeLogLine[], WardenError>, void, void> {
		const target = this.targetOf(session);
		if (!target.success) {
			yield target;
			return;
		}
		let cursor: Cursor = { ts: params.since ?? session.host.now() - DEFAULT_WINDOW_MS, seen: new Set() };
		let batchParams = params;
		const stopped = (): boolean => signal?.aborted === true;
		while (!stopped()) {
			const read = await this.readSince(session, target.data.app, cursor.ts);
			if (!read.success) {
				if (!stopped()) yield read;
				return;
			}
			const seenBefore = cursor.seen;
			const fresh = this.filtered(read.data, batchParams, cursor.ts).filter((l) => !seenBefore.has(this.lineKey(l)));
			batchParams = { ...params, limit: undefined };
			cursor = this.advance(cursor, read.data);
			if (fresh.length > 0) yield resultFactory.ok(fresh);
			if (!(await this.napped(session))) return;
		}
	}

	private advance(cursor: Cursor, lines: readonly NativeLogLine[]): Cursor {
		const ts = lines.reduce((max, l) => Math.max(max, l.ts), cursor.ts);
		const seen = ts > cursor.ts ? new Set<string>() : new Set(cursor.seen);
		for (const line of lines) if (line.ts === ts) seen.add(this.lineKey(line));
		return { ts, seen };
	}

	/** Wait one poll interval; `false` when the wait was cancelled (an aborted session sleep rejects). */
	private async napped(session: OpSession): Promise<boolean> {
		try {
			await session.host.sleep(FOLLOW_POLL_MS);
			return true;
		} catch {
			return false;
		}
	}
}

export const nativeLogOps = new NativeLogOps();
