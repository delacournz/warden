import type { Exec } from "@delacour/warden-core/exec";
import type { AppCommands, Logger } from "../driver.types";
import { driverErr } from "../errors";
import type { AdbSession } from "./adb-session";
import {
	forceStopArgv,
	installArgv,
	monkeyLaunchArgv,
	pidofArgv,
	pmClearArgv,
	pmPathArgv,
	shellCommand,
	startUrlArgv,
	uninstallArgv,
} from "./android-argv";
import { runChecked } from "./android-device";

export type AppDeps = { session: AdbSession; exec: Exec; adb: string; serial: string; log?: Logger };

const ok = { success: true as const, data: undefined };

const NO_ACTIVITY = /No activities found|monkey aborted|Error type 3|does not exist|Unknown package/i;

/** `AppCommands` over `am` / `monkey` / `pm` in the session and host `adb install|uninstall` through `exec`. */
export function createAppCommands(deps: AppDeps): AppCommands {
	const { session, exec, adb, serial } = deps;

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

	const launch: AppCommands["launch"] = async (bundleId, opts) => {
		if ((opts?.args?.length ?? 0) > 0 || Object.keys(opts?.env ?? {}).length > 0) {
			return driverErr(
				"E_UNSUPPORTED",
				"Android launch does not support args/env in v1 (use openUrl with a deep link for dev-client Metro urls)"
			);
		}
		if (opts?.relaunch !== false) {
			const stopped = await terminate(bundleId);
			if (!stopped.success) return stopped;
		}
		const res = await session.run(shellCommand(monkeyLaunchArgv(bundleId)));
		if (!res.success) return res;
		if (res.data.exitCode !== 0 || NO_ACTIVITY.test(res.data.stdout)) {
			return driverErr("E_APP_UNAVAILABLE", `cannot launch ${bundleId}: ${res.data.stdout.trim().slice(0, 200)}`);
		}
		return ok;
	};

	const openUrl: AppCommands["openUrl"] = async (url) => {
		const res = await session.run(shellCommand(startUrlArgv(url)));
		if (!res.success) return res;
		if (res.data.exitCode !== 0 || /^Error:|Exception/m.test(res.data.stdout)) {
			return driverErr("E_APP_UNAVAILABLE", `no activity handles ${url}: ${res.data.stdout.trim().slice(0, 200)}`);
		}
		return ok;
	};

	const install: AppCommands["install"] = async (path) => {
		const res = await hostAdb(installArgv(adb, serial, path));
		return res.ok && res.text.includes("Success")
			? ok
			: driverErr("E_IO", `adb install failed: ${res.text.slice(-200)}`);
	};

	const uninstall: AppCommands["uninstall"] = async (bundleId) => {
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
