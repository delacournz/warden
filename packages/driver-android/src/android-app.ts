import type { AppCommands, DriverResult, Logger } from "@delacour/warden-driver/driver.types";
import { driverErrors } from "@delacour/warden-driver/errors";
import { spanDetails } from "@delacour/warden-driver/trace/span-detail";
import type { Exec } from "@delacour/warden-runtime/exec";
import type { AdbSession } from "./adb-session";
import { androidArgv } from "./android-argv";
import { androidDevice } from "./android-device";

export type AppDeps = {
	session: AdbSession;
	exec: Exec;
	adb: string;
	serial: string;
	log?: Logger;
	/** the app under test: `openUrl` is addressed to it (`am start -p`) so no other handler or chooser can take the link */
	appPackage?: string;
	/** a real phone: `uninstall` and `clearData` only touch `appPackage` and `ownedPackages` (`E_REFUSED` otherwise) */
	physical?: boolean;
	/** packages warden installed on this device besides `appPackage` */
	ownedPackages?: readonly string[];
	/** how long `am start -W` may wait for the first frame (default `START_WAIT_TIMEOUT_MS`); tests shorten it */
	startWaitTimeoutMs?: number;
	/** how long the `pidof` after a timed-out start may take (default `START_PROBE_TIMEOUT_MS`); tests shorten it */
	startProbeTimeoutMs?: number;
};

const ok = { success: true as const, data: undefined };

const NO_ACTIVITY = /No activities found|monkey aborted|Error type 3|does not exist|Unknown package/i;

/** `am start -W` can block for a cold start of a debug build; a dump-sized budget is too short. */
const START_WAIT_TIMEOUT_MS = 30_000;

/** The check after a timed-out `am start -W`: one `pidof` on the restarted shell, which a live device answers at once. */
const START_PROBE_TIMEOUT_MS = 5_000;

const COMPONENT = /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/;

export type StartWait = { status?: string; launchState?: string; totalTimeMs?: number; error?: string };

/** Parsers for the output of `cmd package resolve-activity` and `am start -W`. */
export class AndroidAppParser {
	/** The component on the last non-empty line of `cmd package resolve-activity --brief`; undefined when there is none. */
	parseLauncherComponent(stdout: string): string | undefined {
		const last = stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "")
			.at(-1);
		return last !== undefined && COMPONENT.test(last) ? last : undefined;
	}

	/** What `am start -W` printed: `Status: ok`, `LaunchState: COLD` (API 29+), `TotalTime: 812`, or an `Error:` line. */
	parseStartWait(stdout: string): StartWait {
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
}

export const androidAppParser = new AndroidAppParser();

/**
 * `AppCommands` over `am` / `pm` (and `monkey` when the launcher cannot be resolved) in the session and host
 * `adb install|uninstall` through `exec`. A launch is one `am start -W -S -a MAIN -c LAUNCHER -n <launcher>`: a binder call (no JVM start,
 * where `monkey` is an `app_process` program) that returns once the first frame is drawn.
 */
export class AndroidApp implements AppCommands {
	/** launcher component per package, resolved on the first launch; forgotten by (un)install and a failed start */
	private readonly launchers = new Map<string, string>();

	constructor(private readonly deps: AppDeps) {}

	readonly terminate: AppCommands["terminate"] = async (bundleId) => {
		const res = await androidDevice.runChecked(
			this.deps.session,
			androidArgv.shellCommand(androidArgv.forceStopArgv(bundleId)),
			"E_APP_UNAVAILABLE"
		);
		return res.success ? ok : res;
	};

	readonly isInstalled: AppCommands["isInstalled"] = async (bundleId) => {
		const res = await this.deps.session.run(androidArgv.shellCommand(androidArgv.pmPathArgv(bundleId)));
		if (!res.success) return res;
		return { success: true, data: res.data.exitCode === 0 && res.data.stdout.includes("package:") };
	};

	readonly isRunning: AppCommands["isRunning"] = async (bundleId) => {
		const res = await this.deps.session.run(androidArgv.shellCommand(androidArgv.pidofArgv(bundleId)));
		if (!res.success) return res;
		return { success: true, data: res.data.exitCode === 0 && /\d/.test(res.data.stdout) };
	};

	readonly launch: AppCommands["launch"] = async (bundleId, opts) => {
		if ((opts?.args?.length ?? 0) > 0 || Object.keys(opts?.env ?? {}).length > 0) {
			return driverErrors.err(
				"E_UNSUPPORTED",
				"Android launch does not support args/env in v1 (use openUrl with a deep link for dev-client Metro urls)"
			);
		}
		const relaunch = opts?.relaunch !== false;
		const waited = await this.startWaiting(bundleId, relaunch);
		if (!waited.success) return waited;
		return waited.data ? ok : this.monkeyLaunch(bundleId, relaunch);
	};

	readonly openUrl: AppCommands["openUrl"] = async (url) => {
		const res = await this.deps.session.run(
			androidArgv.shellCommand(androidArgv.startUrlArgv(url, this.deps.appPackage))
		);
		if (!res.success) return res;
		if (res.data.exitCode !== 0 || /^Error:|Exception/m.test(res.data.stdout)) {
			return driverErrors.err(
				"E_APP_UNAVAILABLE",
				`no activity handles ${url}: ${res.data.stdout.trim().slice(0, 200)}`
			);
		}
		return ok;
	};

	readonly install: AppCommands["install"] = async (path) => {
		const { adb, serial } = this.deps;
		this.launchers.clear();
		const res = await this.hostAdb(androidArgv.installArgv(adb, serial, path));
		return res.ok && res.text.includes("Success")
			? ok
			: driverErrors.err("E_IO", `adb install failed: ${res.text.slice(-200)}`);
	};

	readonly uninstall: AppCommands["uninstall"] = async (bundleId) => {
		const { adb, serial } = this.deps;
		const refused = this.protectedPackage(bundleId, "uninstall");
		if (refused) return refused;
		this.launchers.delete(bundleId);
		const installed = await this.isInstalled(bundleId);
		if (!installed.success) return installed;
		if (!installed.data) return ok;
		const res = await this.hostAdb(androidArgv.uninstallArgv(adb, serial, bundleId));
		return res.ok && res.text.includes("Success")
			? ok
			: driverErrors.err("E_IO", `adb uninstall failed: ${res.text.slice(-200)}`);
	};

	readonly clearData: AppCommands["clearData"] = async (bundleId) => {
		const refused = this.protectedPackage(bundleId, "clear the data of");
		if (refused) return refused;
		const res = await androidDevice.runChecked(
			this.deps.session,
			androidArgv.shellCommand(androidArgv.pmClearArgv(bundleId)),
			"E_APP_UNAVAILABLE"
		);
		if (!res.success) return res;
		return res.data.includes("Success")
			? ok
			: driverErrors.err("E_APP_UNAVAILABLE", `pm clear ${bundleId}: ${res.data.trim()}`);
	};

	private async launcherOf(bundleId: string): Promise<string | undefined> {
		const known = this.launchers.get(bundleId);
		if (known !== undefined) return known;
		const res = await this.deps.session.run(androidArgv.shellCommand(androidArgv.resolveLauncherArgv(bundleId)));
		if (!res.success || res.data.exitCode !== 0) return undefined;
		const component = androidAppParser.parseLauncherComponent(res.data.stdout);
		if (component !== undefined) this.launchers.set(bundleId, component);
		return component;
	}

	/** Whether `pidof` on the (restarted) shell shows the app's process; false when the shell does not answer either. */
	private async hasProcess(bundleId: string): Promise<boolean> {
		const probe = await this.deps.session.run(androidArgv.shellCommand(androidArgv.pidofArgv(bundleId)), {
			timeoutMs: this.deps.startProbeTimeoutMs ?? START_PROBE_TIMEOUT_MS,
		});
		return probe.success && probe.data.exitCode === 0 && /\d/.test(probe.data.stdout);
	}

	/** `am start -W` on the resolved launcher: true when it started (detail noted), false to fall back to `monkey`. */
	private async startWaiting(bundleId: string, relaunch: boolean): DriverResult<boolean> {
		const component = await this.launcherOf(bundleId);
		if (component === undefined) return { success: true, data: false };
		const res = await this.deps.session.run(
			androidArgv.shellCommand(androidArgv.startComponentArgv(component, { stop: relaunch })),
			{ timeoutMs: this.deps.startWaitTimeoutMs ?? START_WAIT_TIMEOUT_MS }
		);
		// the start was sent and only the wait for the first frame (held by a keep-on-screen splash, a first bundle) ran
		// out, or the device stopped answering: the session restarted its shell, so the app's process tells them apart
		if (!res.success && res.error.code === "E_TIMEOUT") {
			if (!(await this.hasProcess(bundleId))) return res;
			this.noteStarted({ launchState: "timeout" });
			return { success: true, data: true };
		}
		if (!res.success) return res;
		const started = androidAppParser.parseStartWait(res.data.stdout);
		if (res.data.exitCode !== 0 || started.error !== undefined) {
			this.launchers.delete(bundleId);
			return { success: true, data: false };
		}
		this.noteStarted(started);
		return { success: true, data: true };
	}

	/** The span detail of a launch that `am start -W` made. */
	private noteStarted(started: StartWait): void {
		spanDetails.note("launch", "am-start");
		if (started.status !== undefined) spanDetails.note("startStatus", started.status);
		if (started.launchState !== undefined) spanDetails.note("launchState", started.launchState);
		if (started.totalTimeMs !== undefined) spanDetails.note("totalTimeMs", started.totalTimeMs);
	}

	private async hostAdb(argv: string[]): Promise<{ ok: boolean; text: string }> {
		try {
			const res = await this.deps.exec(argv, { timeoutMs: 120_000 });
			return { ok: res.exitCode === 0, text: `${res.stdout}\n${res.stderr}`.trim() };
		} catch (error) {
			return { ok: false, text: error instanceof Error ? error.message : String(error) };
		}
	}

	/** The fallback launch: force-stop (on a relaunch), then `monkey`, which returns before the first frame. */
	private async monkeyLaunch(bundleId: string, relaunch: boolean): DriverResult<void> {
		if (relaunch) {
			const stopped = await this.terminate(bundleId);
			if (!stopped.success) return stopped;
		}
		spanDetails.note("launch", "monkey");
		const res = await this.deps.session.run(androidArgv.shellCommand(androidArgv.monkeyLaunchArgv(bundleId)));
		if (!res.success) return res;
		if (res.data.exitCode !== 0 || NO_ACTIVITY.test(res.data.stdout)) {
			return driverErrors.err(
				"E_APP_UNAVAILABLE",
				`cannot launch ${bundleId}: ${res.data.stdout.trim().slice(0, 200)}`
			);
		}
		return ok;
	}

	/** On a phone, a package warden did not install is not ours to remove or wipe (invariant: allowlist). */
	private protectedPackage(bundleId: string, action: string): ReturnType<typeof driverErrors.err> | undefined {
		const { physical, appPackage, ownedPackages, serial } = this.deps;
		if (!physical || bundleId === appPackage || ownedPackages?.includes(bundleId)) return undefined;
		return driverErrors.err(
			"E_REFUSED",
			`physical_protected: ${bundleId} was not installed by warden; refusing to ${action} it on physical device ${serial}`,
			{ detail: { reason: "physical_protected", bundleId } }
		);
	}
}
