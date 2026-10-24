import { copyFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "@delacour/warden-core/exec";

export const NATIVE_LOG = "native.log";

/** The app a failing attempt ran: `native.log` and crash reports are read for it only. */
export type NativeTarget =
	| { platform: "ios"; udid: string; bundleId: string }
	| { platform: "android"; serial: string; pkg: string };

export type CrashReport = { name: string; mtimeMs: number };

/** Filesystem seam: where crash reports are read from and `native.log` goes. */
export type NativeFs = {
	listReports(dir: string): CrashReport[];
	copy(from: string, to: string): void;
	write(path: string, text: string): void;
};

export type NativeLogDeps = {
	exec: Exec;
	/** path of the `adb` binary */
	adb: string;
	fs: NativeFs;
	/** `~/Library/Logs/DiagnosticReports` */
	reportsDir: string;
};

export type NativeLogWindow = {
	/** the attempt's directory; files are written into it */
	dir: string;
	/** when the attempt started (ms since epoch) */
	sinceMs: number;
	nowMs: number;
	timeoutMs?: number;
};

export type NativeCapture = { files: string[]; problems: string[] };

const DEFAULT_TIMEOUT_MS = 10_000;
/** `log show` slack so lines logged just before the attempt (the launch) are kept */
const SLACK_S = 5;
/** keep the tail of a runaway log */
const MAX_BYTES = 2_000_000;

export function realNativeFs(): NativeFs {
	return {
		listReports: (dir) => {
			try {
				return readdirSync(dir).map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }));
			} catch {
				return [];
			}
		},
		copy: copyFileSync,
		write: (path, text) => writeFileSync(path, text),
	};
}

export function realNativeLogDeps(exec: Exec, adb: string): NativeLogDeps {
	return { exec, adb, fs: realNativeFs(), reportsDir: join(homedir(), "Library", "Logs", "DiagnosticReports") };
}

function tail(text: string): string {
	return text.length > MAX_BYTES ? text.slice(text.length - MAX_BYTES) : text;
}

function failed(what: string, res: ExecResult): string {
	return `${what}: exit ${res.exitCode} ${res.stderr.trim().split("\n")[0] ?? ""}`.trim();
}

/** `Example.app/Info.plist` → `CFBundleExecutable`, the process name `log show` filters on. */
async function iosProcessName(target: Extract<NativeTarget, { platform: "ios" }>, exec: Exec, timeoutMs: number) {
	const container = await exec(["xcrun", "simctl", "get_app_container", target.udid, target.bundleId, "app"], {
		timeoutMs,
	});
	const app = container.stdout.trim();
	if (container.exitCode !== 0 || !app) return { error: failed(`app container of ${target.bundleId}`, container) };
	const name = await exec(["plutil", "-extract", "CFBundleExecutable", "raw", "-o", "-", join(app, "Info.plist")], {
		timeoutMs,
	});
	const exe = name.stdout.trim();
	return name.exitCode === 0 && exe ? { exe } : { error: failed("CFBundleExecutable", name) };
}

async function iosNativeLog(
	target: Extract<NativeTarget, { platform: "ios" }>,
	deps: NativeLogDeps,
	win: NativeLogWindow,
	timeoutMs: number
): Promise<NativeCapture> {
	const capture: NativeCapture = { files: [], problems: [] };
	const proc = await iosProcessName(target, deps.exec, timeoutMs);
	if (proc.error !== undefined || proc.exe === undefined) {
		capture.problems.push(`native log: ${proc.error ?? "unknown process"}`);
		return capture;
	}
	const seconds = Math.ceil((win.nowMs - win.sinceMs) / 1000) + SLACK_S;
	const show = await deps.exec(
		[
			"xcrun",
			"simctl",
			"spawn",
			target.udid,
			"log",
			"show",
			"--style",
			"ndjson",
			"--last",
			`${seconds}s`,
			"--predicate",
			`process == "${proc.exe}"`,
		],
		{ timeoutMs }
	);
	if (show.exitCode === 0) {
		deps.fs.write(join(win.dir, NATIVE_LOG), tail(show.stdout));
		capture.files.push(NATIVE_LOG);
	} else {
		capture.problems.push(`native log: ${failed("log show", show)}`);
	}
	for (const report of deps.fs.listReports(deps.reportsDir)) {
		if (!report.name.startsWith(proc.exe) || !report.name.endsWith(".ips") || report.mtimeMs < win.sinceMs) continue;
		deps.fs.copy(join(deps.reportsDir, report.name), join(win.dir, report.name));
		capture.files.push(report.name);
	}
	return capture;
}

async function androidNativeLog(
	target: Extract<NativeTarget, { platform: "android" }>,
	deps: NativeLogDeps,
	win: NativeLogWindow,
	timeoutMs: number
): Promise<NativeCapture> {
	const capture: NativeCapture = { files: [], problems: [] };
	const adb = (...args: string[]) => deps.exec([deps.adb, "-s", target.serial, ...args], { timeoutMs });
	const pid = await adb("shell", "pidof", target.pkg);
	const pidArg =
		pid.exitCode === 0 && /^\d+/.test(pid.stdout.trim()) ? [`--pid=${pid.stdout.trim().split(/\s+/)[0]}`] : [];
	const since = ((win.sinceMs - SLACK_S * 1000) / 1000).toFixed(3);
	const main = await adb("logcat", "-d", "-v", "epoch", ...pidArg, "-T", since);
	const crash = await adb("logcat", "-d", "-b", "crash", "-v", "epoch");
	if (main.exitCode !== 0 && crash.exitCode !== 0) {
		capture.problems.push(`native log: ${failed("logcat", main)}`);
		return capture;
	}
	const sections = [
		main.exitCode === 0 ? main.stdout : "",
		crash.exitCode === 0 ? `--- crash buffer ---\n${crash.stdout}` : "",
	];
	deps.fs.write(join(win.dir, NATIVE_LOG), tail(sections.filter(Boolean).join("\n")));
	capture.files.push(NATIVE_LOG);
	return capture;
}

/**
 * `native.log` (and iOS `.ips` crash reports) for a failed attempt, read after the fact: iOS
 * `simctl spawn log show` for the app's process over the attempt's window, Android `logcat -d` for its pid
 * plus the crash buffer. Reading afterwards needs no stream to start, stop or leak. Never throws.
 */
export async function captureNativeLog(
	target: NativeTarget,
	deps: NativeLogDeps,
	win: NativeLogWindow
): Promise<NativeCapture> {
	const timeoutMs = win.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	try {
		return target.platform === "ios"
			? await iosNativeLog(target, deps, win, timeoutMs)
			: await androidNativeLog(target, deps, win, timeoutMs);
	} catch (cause) {
		return { files: [], problems: [`native log: ${cause instanceof Error ? cause.message : String(cause)}`] };
	}
}
