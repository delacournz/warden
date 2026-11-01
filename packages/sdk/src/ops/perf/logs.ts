import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { durationParser } from "@delacour/warden-config/duration";
import { compileGrep, formatEntry, type LogFilter, matchesFilter } from "@delacour/warden-perf/logs/filter";
import { iosPredicate, iosShowArgv, iosStreamArgv, parseCompactLine } from "@delacour/warden-perf/logs/ios-log";
import { LOG_LEVELS, type LogEntry, parseLevel } from "@delacour/warden-perf/logs/levels";
import { logcatArgv, parseDeviceDate, parseThreadtime } from "@delacour/warden-perf/logs/logcat";
import { followPid, type LogStream, type SpawnLines } from "@delacour/warden-perf/logs/pid-follow";
import { redact } from "@delacour/warden-perf/logs/redact";
import { androidTools } from "@delacour/warden-providers/android-tools";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { opError } from "../errors";
import { appPid, iosAppBundle } from "./app-process";
import type { PerfEnv, PerfUiEnv } from "./env";
import type { PerfOutcome, PerfTarget } from "./types";

/** Lines `warden perf logs` prints when `--lines` is not given. */
export const DEFAULT_LOG_LINES = 200;
/** How far back an iOS one-shot read goes when `--since` is not given. */
const DEFAULT_IOS_WINDOW_S = 300;
/** A filtered Android read pulls this many lines before filtering (the device tails before we can filter). */
const FILTERED_TAIL = 10_000;

/** What log capture reaches the machine through; tests inject fakes. */
export type LogDeps = {
	spawn: SpawnLines;
	sleep: (ms: number) => Promise<void>;
	/** Ctrl-C as an abort signal; `dispose` unhooks it */
	interrupt: () => { signal: AbortSignal; dispose: () => void };
};

/** Run `argv` and hand stdout to `onLine` line by line. A binary that cannot start ends with exit 127. */
function spawnLines(argv: string[], onLine: (line: string) => void): LogStream {
	try {
		const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
		const exited = (async () => {
			const decoder = new TextDecoder();
			let buffer = "";
			for await (const chunk of proc.stdout) {
				buffer += decoder.decode(chunk, { stream: true });
				for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
					onLine(buffer.slice(0, i));
					buffer = buffer.slice(i + 1);
				}
			}
			if (buffer !== "") onLine(buffer);
			return proc.exited;
		})();
		return { kill: () => proc.kill(), exited };
	} catch {
		return { kill: () => {}, exited: Promise.resolve(127) };
	}
}

export const defaultLogDeps: LogDeps = {
	spawn: spawnLines,
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	interrupt: () => {
		const controller = new AbortController();
		const onSigint = () => controller.abort();
		process.once("SIGINT", onSigint);
		return { signal: controller.signal, dispose: () => process.off("SIGINT", onSigint) };
	},
};

export type DeviceRef = { udid: string; platform: "ios" | "android" };

const adb = (ctx: PerfEnv, serial: string): string[] => [androidTools(ctx.env).adb, "-s", serial];

/** Wall clock of `ms` read as UTC, in the host's zone: what iOS stamps look like. */
const hostNaive = (ms: number): number => ms - new Date(ms).getTimezoneOffset() * 60_000;

/** The zone-less "now" lines on this device are stamped against (Android: the device clock, else the host's). */
export async function deviceNaiveNow(ctx: PerfEnv, device: DeviceRef): Promise<number> {
	if (device.platform === "android") {
		const res = await ctx.exec([...adb(ctx, device.udid), "shell", "date", "+%Y-%m-%d %H:%M:%S"], { timeoutMs: 5_000 });
		const parsed = res.exitCode === 0 ? parseDeviceDate(res.stdout) : undefined;
		if (parsed !== undefined) return parsed;
	}
	return hostNaive(ctx.now());
}

export function parseLogLine(platform: "ios" | "android", raw: string, year: number): LogEntry | undefined {
	return platform === "ios" ? parseCompactLine(raw) : parseThreadtime(raw, year);
}

export type LogFlags = { level?: string; grep?: string; since?: string; lines?: string };

export type ParsedFlags = { filter: LogFilter; sinceDurationMs?: number; lines: number };

export function parseFlags(flags: LogFlags): Result<ParsedFlags, WardenError> {
	const usage = (message: string): Result<ParsedFlags, WardenError> => ({
		success: false,
		error: opError("usage", message),
	});
	const filter: LogFilter = {};
	if (flags.level !== undefined) {
		const level = parseLevel(flags.level);
		if (level === undefined)
			return usage(
				`--level must be one of ${LOG_LEVELS.join(" ")} (or verbose|debug|info|warn|error|fatal), got "${flags.level}"`
			);
		filter.minLevel = level;
	}
	if (flags.grep !== undefined) {
		const grep = compileGrep(flags.grep);
		if (!grep.success) return usage(grep.error);
		filter.grep = grep.data;
	}
	let sinceDurationMs: number | undefined;
	if (flags.since !== undefined) {
		const since = durationParser.parse(flags.since);
		if (!since.success) return usage(`--since: ${since.error}`);
		sinceDurationMs = since.data;
	}
	if (flags.lines !== undefined && (!/^\d+$/.test(flags.lines) || Number(flags.lines) < 1)) {
		return usage(`--lines must be a positive integer, got "${flags.lines}"`);
	}
	return resultFactory.ok({
		filter,
		...(sinceDurationMs !== undefined ? { sinceDurationMs } : {}),
		lines: flags.lines === undefined ? DEFAULT_LOG_LINES : Number(flags.lines),
	});
}

/**
 * Stream one app's logs until `signal` aborts, handing each redacted raw line to `onLine`. Android follows the app's
 * pid across restarts (`logcat --pid`, re-resolved every 2s); iOS runs `log stream` on the simulator with a
 * subsystem/process predicate. Resolves with an error when the app cannot be found or the stream ends by itself.
 */
export async function streamAppLogs(
	ctx: PerfEnv,
	device: DeviceRef,
	app: { id: string },
	run: { signal: AbortSignal; onLine: (line: string) => void },
	deps: LogDeps = defaultLogDeps
): Promise<Result<void, WardenError>> {
	const onLine = (raw: string) => run.onLine(redact(raw));
	if (device.platform === "android") {
		await followPid({
			resolvePid: () => appPid(ctx, { platform: "android", id: device.udid }, app.id),
			argvFor: (pid) => [...adb(ctx, device.udid), ...logcatArgv(pid)],
			spawn: deps.spawn,
			sleep: deps.sleep,
			onLine,
			signal: run.signal,
		});
		return resultFactory.ok(undefined);
	}
	const bundle = await iosAppBundle(ctx, device.udid, app.id);
	if (!bundle.success) return bundle;
	const argv = [
		"xcrun",
		"simctl",
		"spawn",
		device.udid,
		...iosStreamArgv(iosPredicate(app.id, bundle.data.executable)),
	];
	const stream = deps.spawn(argv, onLine);
	const aborted = new Promise<"aborted">((resolve) => {
		if (run.signal.aborted) resolve("aborted");
		else run.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
	});
	const first = await Promise.race([aborted, stream.exited]);
	stream.kill();
	if (first === "aborted") return resultFactory.ok(undefined);
	return {
		success: false,
		error: opError("failed", `log stream ended (exit ${first})`, { hint: "is the simulator still booted?" }),
	};
}

/**
 * Collector entry point: append the app's redacted logs to `outFile` (`<session>/logs/device.log`) until `signal`
 * aborts. Returns how many lines were written.
 */
export async function runLogCapture(
	ctx: PerfEnv,
	target: DeviceRef,
	app: { id: string },
	outFile: string,
	signal: AbortSignal,
	deps: LogDeps = defaultLogDeps
): Promise<Result<{ lines: number }, WardenError>> {
	mkdirSync(dirname(outFile), { recursive: true });
	let lines = 0;
	const done = await streamAppLogs(
		ctx,
		target,
		app,
		{
			signal,
			onLine: (line) => {
				lines++;
				appendFileSync(outFile, `${line}\n`);
			},
		},
		deps
	);
	return done.success ? resultFactory.ok({ lines }) : done;
}

export type OneShot = { entries: LogEntry[]; truncated: boolean };

/** The failed `exec` as a `failed` error naming the tool and the last line of its output. */
function execFailure(what: string, res: { exitCode: number; stdout: string; stderr: string }): WardenError {
	return opError("failed", `${what} failed: ${(res.stderr || res.stdout).trim().split("\n").pop() ?? res.exitCode}`);
}

/** Android: the app's pid-scoped logcat tail. */
async function androidLogcat(
	ctx: PerfEnv,
	device: DeviceRef,
	appId: string,
	tail: number,
	timeoutMs: number
): Promise<Result<string, WardenError>> {
	const pid = await appPid(ctx, { platform: "android", id: device.udid }, appId);
	if (pid === undefined) {
		return {
			success: false,
			error: opError("app_not_found", `${appId} is not running on ${device.udid}`, {
				hint: "launch the app, or check `warden perf crashes` for why it died",
			}),
		};
	}
	const res = await ctx.exec([...adb(ctx, device.udid), ...logcatArgv(pid, { tail })], { timeoutMs });
	if (res.exitCode !== 0) return { success: false, error: execFailure("logcat", res) };
	return resultFactory.ok(res.stdout);
}

/** iOS: `log show` for the app over the `--since` window (default `DEFAULT_IOS_WINDOW_S`). */
async function iosLogShow(
	ctx: PerfEnv,
	device: DeviceRef,
	appId: string,
	sinceDurationMs: number | undefined,
	timeoutMs: number
): Promise<Result<string, WardenError>> {
	const bundle = await iosAppBundle(ctx, device.udid, appId);
	if (!bundle.success) return bundle;
	const window = sinceDurationMs === undefined ? DEFAULT_IOS_WINDOW_S : Math.max(1, Math.ceil(sinceDurationMs / 1000));
	const argv = [
		"xcrun",
		"simctl",
		"spawn",
		device.udid,
		...iosShowArgv(iosPredicate(appId, bundle.data.executable), `${window}s`),
	];
	const res = await ctx.exec(argv, { timeoutMs });
	if (res.exitCode !== 0) return { success: false, error: execFailure("log show", res) };
	return resultFactory.ok(res.stdout);
}

export async function readOnce(
	ctx: PerfEnv,
	device: DeviceRef,
	app: { id: string },
	flags: ParsedFlags,
	timeoutMs: number
): Promise<Result<OneShot, WardenError>> {
	const naiveNow = await deviceNaiveNow(ctx, device);
	const year = new Date(naiveNow).getUTCFullYear();
	const filtered =
		flags.filter.minLevel !== undefined || flags.filter.grep !== undefined || flags.sinceDurationMs !== undefined;
	const filter: LogFilter = { ...flags.filter };
	if (flags.sinceDurationMs !== undefined) filter.sinceMs = naiveNow - flags.sinceDurationMs;
	const isAndroid = device.platform === "android";
	const out = isAndroid
		? await androidLogcat(ctx, device, app.id, filtered ? FILTERED_TAIL : flags.lines, timeoutMs)
		: await iosLogShow(ctx, device, app.id, flags.sinceDurationMs, timeoutMs);
	if (!out.success) return out;
	if (!isAndroid) delete filter.sinceMs;
	const all = redact(out.data)
		.split("\n")
		.flatMap((line) => parseLogLine(device.platform, line, year) ?? [])
		.filter((entry) => matchesFilter(entry, filter));
	return resultFactory.ok({ entries: all.slice(-flags.lines), truncated: all.length > flags.lines });
}

/** The `result` of `perf logs --json` (one-shot). */
export type LogsResult = { app: string; count: number; truncated: boolean; entries: LogEntry[] };

/** The one-shot logs work of a resolved device and app: read the window, filter, render. */
export async function logsWork(
	ctx: PerfUiEnv,
	target: PerfTarget,
	app: { id: string },
	flags: ParsedFlags,
	timeoutMs: number
): PerfOutcome<LogsResult> {
	const read = await readOnce(ctx, target, app, flags, timeoutMs);
	if (!read.success) return read;
	const { entries, truncated } = read.data;
	const text =
		entries.length === 0 ? ctx.ui.color.dim(`no log lines from ${app.id}`) : entries.map(formatEntry).join("\n");
	return resultFactory.ok({
		device: { udid: target.udid, platform: target.platform, name: target.name },
		result: { app: app.id, count: entries.length, truncated, entries },
		text,
		...(truncated ? { warnings: [`showing the last ${flags.lines} lines (raise --lines)`] } : {}),
	});
}

/** Where a followed log stream stands: the filter and year its lines are parsed with. */
export type FollowSetup = { filter: LogFilter; year: number };

/** The filter and year `--follow` parses lines with: the `since` window anchored on the device clock. */
export async function followSetup(ctx: PerfEnv, target: DeviceRef, flags: ParsedFlags): Promise<FollowSetup> {
	const filter: LogFilter = { ...flags.filter };
	const naiveNow = await deviceNaiveNow(ctx, target);
	if (flags.sinceDurationMs !== undefined) filter.sinceMs = naiveNow - flags.sinceDurationMs;
	return { filter, year: new Date(naiveNow).getUTCFullYear() };
}

/**
 * The app's live log entries (filtered, redacted) until `signal` aborts. Ends with an error thrown by the iterator when
 * the stream cannot start (app not found) or dies by itself; an abort ends it cleanly.
 */
export async function* followLogEntries(
	ctx: PerfEnv,
	target: DeviceRef,
	app: { id: string },
	flags: ParsedFlags,
	signal: AbortSignal,
	deps: LogDeps = defaultLogDeps
): AsyncGenerator<LogEntry, void, void> {
	const { filter, year } = await followSetup(ctx, target, flags);
	const queue: LogEntry[] = [];
	let wake: (() => void) | undefined;
	let failure: WardenError | undefined;
	let finished = false;
	const poke = (): void => {
		wake?.();
		wake = undefined;
	};
	void streamAppLogs(
		ctx,
		target,
		app,
		{
			signal,
			onLine: (raw) => {
				const entry = parseLogLine(target.platform, raw, year);
				if (entry === undefined || !matchesFilter(entry, filter)) return;
				queue.push(entry);
				poke();
			},
		},
		deps
	).then((done) => {
		if (!done.success) failure = done.error;
		finished = true;
		poke();
	});
	for (;;) {
		const next = queue.shift();
		if (next !== undefined) {
			yield next;
			continue;
		}
		if (finished) break;
		await new Promise<void>((resolve) => {
			wake = resolve;
		});
	}
	if (failure !== undefined) throw new LogStreamError(failure);
}

/** A log stream that could not start or ended by itself, carrying the typed error. */
export class LogStreamError extends Error {
	constructor(readonly error: WardenError) {
		super(error.message);
	}
}
