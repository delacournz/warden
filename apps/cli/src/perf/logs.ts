import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Command as Commander } from "@commander-js/extra-typings";
import { parseDuration } from "@delacour/warden-core/duration";
import { androidTools } from "@delacour/warden-core/providers/android";
import { compileGrep, formatEntry, type LogFilter, matchesFilter } from "@delacour/warden-perf/logs/filter";
import { iosPredicate, iosShowArgv, iosStreamArgv, parseCompactLine } from "@delacour/warden-perf/logs/ios-log";
import { LOG_LEVELS, type LogEntry, type LogLevel, parseLevel } from "@delacour/warden-perf/logs/levels";
import { logcatArgv, parseDeviceDate, parseThreadtime } from "@delacour/warden-perf/logs/logcat";
import { followPid, type LogStream, type SpawnLines } from "@delacour/warden-perf/logs/pid-follow";
import { redact } from "@delacour/warden-perf/logs/redact";
import { ok, type Result } from "@delacour/warden-types/result";
import { reportError, UI_EXIT, type UiError, uiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { errorMessage } from "../hooks/json";
import { resolveApp } from "./app";
import { appPid, iosAppBundle } from "./app-process";
import { resolvePerfDevice } from "./device";
import { withPerfOptions } from "./options";
import { type PerfDeps, type PerfOptionValues, runPerf } from "./run";

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

type DeviceRef = { udid: string; platform: "ios" | "android" };

const adb = (ctx: CommandContext, serial: string): string[] => [androidTools(ctx.env).adb, "-s", serial];

/** Wall clock of `ms` read as UTC, in the host's zone: what iOS stamps look like. */
const hostNaive = (ms: number): number => ms - new Date(ms).getTimezoneOffset() * 60_000;

/** The zone-less "now" lines on this device are stamped against (Android: the device clock, else the host's). */
async function deviceNaiveNow(ctx: CommandContext, device: DeviceRef): Promise<number> {
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

type LogFlags = { level?: string; grep?: string; since?: string; lines?: string };

type ParsedFlags = { filter: LogFilter; sinceDurationMs?: number; lines: number };

function parseFlags(flags: LogFlags): Result<ParsedFlags, UiError> {
	const usage = (message: string): Result<ParsedFlags, UiError> => ({
		success: false,
		error: uiError("usage", message),
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
		const since = parseDuration(flags.since);
		if (!since.success) return usage(`--since: ${since.error}`);
		sinceDurationMs = since.data;
	}
	if (flags.lines !== undefined && (!/^\d+$/.test(flags.lines) || Number(flags.lines) < 1)) {
		return usage(`--lines must be a positive integer, got "${flags.lines}"`);
	}
	return ok({
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
	ctx: CommandContext,
	device: DeviceRef,
	app: { id: string },
	run: { signal: AbortSignal; onLine: (line: string) => void },
	deps: LogDeps = defaultLogDeps
): Promise<Result<void, UiError>> {
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
		return ok(undefined);
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
	if (first === "aborted") return ok(undefined);
	return {
		success: false,
		error: uiError("failed", `log stream ended (exit ${first})`, { hint: "is the simulator still booted?" }),
	};
}

/**
 * Collector entry point: append the app's redacted logs to `outFile` (`<session>/logs/device.log`) until `signal`
 * aborts. Returns how many lines were written.
 */
export async function runLogCapture(
	ctx: CommandContext,
	target: DeviceRef,
	app: { id: string },
	outFile: string,
	signal: AbortSignal,
	deps: LogDeps = defaultLogDeps
): Promise<Result<{ lines: number }, UiError>> {
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
	return done.success ? ok({ lines }) : done;
}

type OneShot = { entries: LogEntry[]; truncated: boolean };

/** The failed `exec` as a `failed` error naming the tool and the last line of its output. */
function execFailure(what: string, res: { exitCode: number; stdout: string; stderr: string }): UiError {
	return uiError("failed", `${what} failed: ${(res.stderr || res.stdout).trim().split("\n").pop() ?? res.exitCode}`);
}

/** Android: the app's pid-scoped logcat tail. */
async function androidLogcat(
	ctx: CommandContext,
	device: DeviceRef,
	appId: string,
	tail: number,
	timeoutMs: number
): Promise<Result<string, UiError>> {
	const pid = await appPid(ctx, { platform: "android", id: device.udid }, appId);
	if (pid === undefined) {
		return {
			success: false,
			error: uiError("app_not_found", `${appId} is not running on ${device.udid}`, {
				hint: "launch the app, or check `warden perf crashes` for why it died",
			}),
		};
	}
	const res = await ctx.exec([...adb(ctx, device.udid), ...logcatArgv(pid, { tail })], { timeoutMs });
	if (res.exitCode !== 0) return { success: false, error: execFailure("logcat", res) };
	return ok(res.stdout);
}

/** iOS: `log show` for the app over the `--since` window (default `DEFAULT_IOS_WINDOW_S`). */
async function iosLogShow(
	ctx: CommandContext,
	device: DeviceRef,
	appId: string,
	sinceDurationMs: number | undefined,
	timeoutMs: number
): Promise<Result<string, UiError>> {
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
	return ok(res.stdout);
}

async function readOnce(
	ctx: CommandContext,
	device: DeviceRef,
	app: { id: string },
	flags: ParsedFlags,
	timeoutMs: number
): Promise<Result<OneShot, UiError>> {
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
	return ok({ entries: all.slice(-flags.lines), truncated: all.length > flags.lines });
}

export type PerfLogsOptions = PerfOptionValues & LogFlags & { follow?: true };

/**
 * `warden perf logs`: the app's recent device logs (redacted), or with `--follow` a live stream (NDJSON under
 * `--json`; Ctrl-C exits 130). An `observe` op: needs no lease.
 */
export async function perfLogs(
	ctx: CommandContext,
	deps: PerfDeps,
	opts: PerfLogsOptions,
	logDeps: LogDeps = defaultLogDeps
): Promise<number> {
	const flags = parseFlags(opts);
	if (opts.follow === true) return followLogs(ctx, deps, opts, flags, logDeps);
	return runPerf(ctx, deps, "logs", "observe", opts, async (target, env) => {
		if (!flags.success) return flags;
		const app = await resolveApp(ctx, { platform: target.platform, id: target.udid }, opts.app);
		if (!app.success) return app;
		const read = await readOnce(ctx, target, app.data, flags.data, env.timeoutMs);
		if (!read.success) return read;
		const { entries, truncated } = read.data;
		const info = { udid: target.udid, platform: target.platform, name: target.name };
		const text =
			entries.length === 0 ? ctx.ui.color.dim(`no log lines from ${app.data.id}`) : entries.map(formatEntry).join("\n");
		return ok({
			device: info,
			result: { app: app.data.id, count: entries.length, truncated, entries },
			text,
			...(truncated ? { warnings: [`showing the last ${flags.data.lines} lines (raise --lines)`] } : {}),
		});
	});
}

async function followLogs(
	ctx: CommandContext,
	deps: PerfDeps,
	opts: PerfLogsOptions,
	flags: Result<ParsedFlags, UiError>,
	logDeps: LogDeps
): Promise<number> {
	const json = opts.json === true;
	const report = { command: "perf logs", label: "perf logs", json, startedAt: ctx.now() };
	try {
		if (!flags.success) return reportError(ctx, report, flags.error);
		const target = await resolvePerfDevice(ctx, opts, "observe", deps.device);
		if (!target.success) return reportError(ctx, report, target.error);
		const info = { udid: target.data.udid, platform: target.data.platform, name: target.data.name };
		const app = await resolveApp(ctx, { platform: target.data.platform, id: target.data.udid }, opts.app);
		if (!app.success) return reportError(ctx, report, app.error, info);
		const filter: LogFilter = { ...flags.data.filter };
		const naiveNow = await deviceNaiveNow(ctx, target.data);
		if (flags.data.sinceDurationMs !== undefined) filter.sinceMs = naiveNow - flags.data.sinceDurationMs;
		const year = new Date(naiveNow).getUTCFullYear();
		const interrupt = logDeps.interrupt();
		try {
			const done = await streamAppLogs(
				ctx,
				target.data,
				app.data,
				{
					signal: interrupt.signal,
					onLine: (raw) => {
						const entry = parseLogLine(target.data.platform, raw, year);
						if (entry === undefined || !matchesFilter(entry, filter)) return;
						ctx.out(json ? JSON.stringify(entry) : formatEntry(entry));
					},
				},
				logDeps
			);
			if (!done.success) return reportError(ctx, report, done.error, info);
			return interrupt.signal.aborted ? UI_EXIT.interrupted : UI_EXIT.ok;
		} finally {
			interrupt.dispose();
		}
	} catch (error) {
		return reportError(ctx, report, uiError("failed", errorMessage(error)));
	}
}

const LEVEL_HELP: LogLevel[] = [...LOG_LEVELS];

/** Wire `logs` onto `warden perf`. */
export function registerLogs(cmd: Commander, ctx: CommandContext, done: (code: number) => void, deps: PerfDeps): void {
	withPerfOptions(
		cmd
			.command("logs")
			.description("the app's device logs, secrets redacted (--follow streams; Ctrl-C exits 130)")
			.option("-f, --follow", "stream live (text lines, or NDJSON with --json)")
			.option("--level <level>", `minimum level: ${LEVEL_HELP.join(" ")} (default: all)`)
			.option("--grep <regex>", "keep lines whose tag or message matches (case-insensitive)")
			.option("--since <duration>", "only lines from the last 30s | 5m | 1h")
			.option("-n, --lines <n>", `lines to show, newest last (default ${DEFAULT_LOG_LINES})`)
	).action(async (opts) => {
		done(await perfLogs(ctx, deps, opts));
	});
}
