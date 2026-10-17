import type { Exec } from "@delacour/warden-core/exec";
import type { AppCommands, DriverResult, Logger } from "../driver.types";
import { driverErr } from "../errors";
import { noteSpanDetail } from "../span-detail";
import type { AdbSession } from "./adb-session";
import {
	forceStopArgv,
	installArgv,
	monkeyLaunchArgv,
	pidofArgv,
	pmClearArgv,
	pmPathArgv,
	resolveLauncherArgv,
	shellCommand,
	startComponentArgv,
	startUrlArgv,
	uninstallArgv,
} from "./android-argv";
import { runChecked } from "./android-device";

export type AppDeps = {
	session: AdbSession;
	exec: Exec;
	adb: string;
	serial: string;
	log?: Logger;
	/** the app under test: `openUrl` is addressed to it (`am start -p`) so no other handler or chooser can take the link */
	appPackage?: string;
};

const ok = { success: true as const, data: undefined };

const NO_ACTIVITY = /No activities found|monkey aborted|Error type 3|does not exist|Unknown package/i;

/** `am start -W` can block for a cold start of a debug build; a dump-sized budget is too short. */
const START_WAIT_TIMEOUT_MS = 30_000;

const COMPONENT = /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/;

/** The component on the last non-empty line of `cmd package resolve-activity --brief`; undefined when there is none. */
export function parseLauncherComponent(stdout: string): string | undefined {
	const last = stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.at(-1);
	return last !== undefined && COMPONENT.test(last) ? last : undefined;
}

export type StartWait = { status?: string; launchState?: string; totalTimeMs?: number; error?: string };

/** What `am start -W` printed: `Status: ok`, `LaunchState: COLD` (API 29+), `TotalTime: 812`, or an `Error:` line. */
export function parseStartWait(stdout: string): StartWait {
	const field = (name: string): string | undefined => new RegExp(`^${name}: *(.+)$`, "m").exec(stdout)?.[1]?.trim();
	const parsed: StartWait = {};
	const status = field("Status");
	const launchState = field("LaunchState");
	const totalTime = Number(field("TotalTime"));
	const error = /^Error: *(.+)$/m.exec(stdout)?.[1]?.trim();
	if (status !== undefined) parsed.status = status;
	if (launchState !== undefined) parsed.launchState = launchState;
	if (Number.isFinite(totalTime) && field("TotalTime") !== undefined) parsed.totalTimeMs = totalTime;
	if (error !== undefined) parsed.error = error;
	return parsed;
}

/**
 * `AppCommands` over `am` / `pm` (and `monkey` when the launcher cannot be resolved) in the session and host
 * `adb install|uninstall` through `exec`. A launch is one `am start -W -S -n <launcher>`: a binder call (no JVM start,
 * where `monkey` is an `app_process` program) that returns once the first frame is drawn.
 */
export function createAppCommands(deps: AppDeps): AppCommands {
	const { session, exec, adb, serial } = deps;
	/** launcher component per package, resolved on the first launch; forgotten by (un)install and a failed start */
	const launchers = new Map<string, string>();

	const launcherOf = async (bundleId: string): Promise<string | undefined> => {
		const known = launchers.get(bundleId);
		if (known !== undefined) return known;
		const res = await session.run(shellCommand(resolveLauncherArgv(bundleId)));
		if (!res.success || res.data.exitCode !== 0) return undefined;
		const component = parseLauncherComponent(res.data.stdout);
		if (component !== undefined) launchers.set(bundleId, component);
		return component;
	};

	/** `am start -W` on the resolved launcher: true when it started (detail noted), false to fall back to `monkey`. */
	const startWaiting = async (bundleId: string, relaunch: boolean): DriverResult<boolean> => {
		const component = await launcherOf(bundleId);
		if (component === undefined) return { success: true, data: false };
		const res = await session.run(shellCommand(startComponentArgv(component, { stop: relaunch })), {
			timeoutMs: START_WAIT_TIMEOUT_MS,
		});
		if (!res.success) return res;
		const started = parseStartWait(res.data.stdout);
		if (res.data.exitCode !== 0 || started.error !== undefined) {
			launchers.delete(bundleId);
			return { success: true, data: false };
		}
		noteSpanDetail("launch", "am-start");
		if (started.status !== undefined) noteSpanDetail("startStatus", started.status);
		if (started.launchState !== undefined) noteSpanDetail("launchState", started.launchState);
		if (started.totalTimeMs !== undefined) noteSpanDetail("totalTimeMs", started.totalTimeMs);
		return { success: true, data: true };
	};

	async function hostAdb(argv: string[]): Promise<{ ok: boolean; text: string }> {
		try {
			const res = await exec(argv, { timeoutMs: 120_000 });
			return { ok: res.exitCode === 0, text: `${res.stdout}\n${res.stderr}`.trim() };
		} catch (error) {
			return { ok: false, text: error instanceof Error ? error.message : String(error) };
		}
	}

	const terminate: AppCommands["terminate"] = async (bundleId) => {
		const res = await runChecked(session, shellCommand(forceStopArgv(bundleId)), "E_APP_UNAVAILABLE");
		return res.success ? ok : res;
	};

	const isInstalled: AppCommands["isInstalled"] = async (bundleId) => {
		const res = await session.run(shellCommand(pmPathArgv(bundleId)));
		if (!res.success) return res;
		return { success: true, data: res.data.exitCode === 0 && res.data.stdout.includes("package:") };
	};

	const isRunning: AppCommands["isRunning"] = async (bundleId) => {
		const res = await session.run(shellCommand(pidofArgv(bundleId)));
		if (!res.success) return res;
		return { success: true, data: res.data.exitCode === 0 && /\d/.test(res.data.stdout) };
	};

	/** The fallback launch: force-stop (on a relaunch), then `monkey`, which returns before the first frame. */
	const monkeyLaunch = async (bundleId: string, relaunch: boolean): DriverResult<void> => {
		if (relaunch) {
			const stopped = await terminate(bundleId);
			if (!stopped.success) return stopped;
		}
		noteSpanDetail("launch", "monkey");
		const res = await session.run(shellCommand(monkeyLaunchArgv(bundleId)));
		if (!res.success) return res;
		if (res.data.exitCode !== 0 || NO_ACTIVITY.test(res.data.stdout)) {
			return driverErr("E_APP_UNAVAILABLE", `cannot launch ${bundleId}: ${res.data.stdout.trim().slice(0, 200)}`);
		}
		return ok;
	};

	const launch: AppCommands["launch"] = async (bundleId, opts) => {
		if ((opts?.args?.length ?? 0) > 0 || Object.keys(opts?.env ?? {}).length > 0) {
			return driverErr(
				"E_UNSUPPORTED",
				"Android launch does not support args/env in v1 (use openUrl with a deep link for dev-client Metro urls)"
			);
		}
		const relaunch = opts?.relaunch !== false;
		const waited = await startWaiting(bundleId, relaunch);
		if (!waited.success) return waited;
		return waited.data ? ok : monkeyLaunch(bundleId, relaunch);
	};

	const openUrl: AppCommands["openUrl"] = async (url) => {
		const res = await session.run(shellCommand(startUrlArgv(url, deps.appPackage)));
		if (!res.success) return res;
		if (res.data.exitCode !== 0 || /^Error:|Exception/m.test(res.data.stdout)) {
			return driverErr("E_APP_UNAVAILABLE", `no activity handles ${url}: ${res.data.stdout.trim().slice(0, 200)}`);
		}
		return ok;
	};

	const install: AppCommands["install"] = async (path) => {
		launchers.clear();
		const res = await hostAdb(installArgv(adb, serial, path));
		return res.ok && res.text.includes("Success")
			? ok
			: driverErr("E_IO", `adb install failed: ${res.text.slice(-200)}`);
	};

	const uninstall: AppCommands["uninstall"] = async (bundleId) => {
		launchers.delete(bundleId);
		const installed = await isInstalled(bundleId);
		if (!installed.success) return installed;
		if (!installed.data) return ok;
		const res = await hostAdb(uninstallArgv(adb, serial, bundleId));
		return res.ok && res.text.includes("Success")
			? ok
			: driverErr("E_IO", `adb uninstall failed: ${res.text.slice(-200)}`);
	};

	const clearData: AppCommands["clearData"] = async (bundleId) => {
		const res = await runChecked(session, shellCommand(pmClearArgv(bundleId)), "E_APP_UNAVAILABLE");
		if (!res.success) return res;
		return res.data.includes("Success")
			? ok
			: driverErr("E_APP_UNAVAILABLE", `pm clear ${bundleId}: ${res.data.trim()}`);
	};

	return { launch, terminate, openUrl, install, uninstall, isInstalled, isRunning, clearData };
}
