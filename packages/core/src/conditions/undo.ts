import { ok, type Result } from "@delacour/warden-types/result";
import { readCameraMode, usesVideo } from "../camera-mode";
import { resetCameraFeeds } from "../camera-placeholder";
import { PENDING_PREFIX } from "../claim";
import { type Exec, execError } from "../exec";
import type { PidAlive } from "../liveness";
import { androidTools, forgetAndroidEmulator } from "../providers/android";
import { adbShellArgv } from "../shell-words";
import { type Store, wardenHome } from "../store";
import type { Lease, Platform } from "../types";
import {
	androidA11yResets,
	androidScreenReaderResets,
	iosDefaultsDeleteArgvs,
	iosDefaultsFields,
	iosDefaultsMissing,
} from "./a11y-keys";
import { cameraFeedDir, clearCameraFeeds } from "./camera-media";
import { activeConditions, clearCondition } from "./conditions";
import {
	type ConditionArea,
	type ConditionRecord,
	IME_STASH_DEFAULT,
	IME_STASH_ENABLED,
	PASSKEY_PROVIDER_PACKAGE,
	type PasskeyProviderSettings,
} from "./conditions.types";
import { injectStatePath, neutralizeInjectState } from "./inject-state";
import { launchSettingsPath, writeLaunchSettings } from "./launch-settings";
import { passkeyStorePath, removePasskeyStore } from "./passkey-paths";

export type UndoDeps = {
	store: Store;
	exec: Exec;
	env: Record<string, string | undefined>;
	now: () => number;
	pidAlive: PidAlive;
	/** SIGTERM an owned process */
	kill: (pid: number) => void;
	/** stop the lease's shaping proxy, free its port lease and handle file (`releaseLeaseProxy`); injected so undo stays pure */
	releaseProxy?: (leaseId: string) => Promise<boolean>;
	/** the host's timezone, for an Android timezone whose previous value was not recorded (default: `Intl`) */
	hostTimezone?: () => string;
};

export type UndoReport = { reset: ConditionArea[]; killed: number[] };

/** `errors`: one line per failed reset; `report`: what did get undone. */
export type UndoFailure = { errors: string[]; report: UndoReport };

/** Reset commands for one active area on one platform; an area with no device-side state has none. */
function resetCommands(
	platform: Platform,
	serial: string,
	record: ConditionRecord,
	deps: Pick<UndoDeps, "env" | "now" | "hostTimezone">
): string[][] {
	if (platform === "ios") {
		switch (record.area) {
			case "location":
				return [["xcrun", "simctl", "location", serial, "clear"]];
			case "permission":
				return [["xcrun", "simctl", "privacy", serial, "reset", "all"]];
			case "a11y": {
				const written = iosDefaultsFields(record.value);
				return [
					["xcrun", "simctl", "ui", serial, "content_size", "large"],
					["xcrun", "simctl", "ui", serial, "increase_contrast", "disabled"],
					...iosDefaultsDeleteArgvs(serial, written),
				];
			}
			case "battery":
				return [["xcrun", "simctl", "status_bar", serial, "clear"]];
			default:
				return [];
		}
	}
	const { adb } = androidTools(deps.env);
	const base = [adb, "-s", serial];
	switch (record.area) {
		case "network":
			return [
				[...base, "emu", "network", "speed", "full"],
				[...base, "emu", "network", "delay", "none"],
				[...base, "shell", "cmd", "connectivity", "airplane-mode", "disable"],
				[...base, "shell", "settings", "put", "global", "http_proxy", ":0"],
			];
		case "clock":
			return [
				[...base, "shell", "settings", "put", "global", "auto_time", "1"],
				[...base, "shell", "cmd", "alarm", "set-time", String(deps.now())],
			];
		case "permission":
			return [[...base, "shell", "pm", "reset-permissions"]];
		case "a11y":
			return [
				[...base, "shell", "settings", "put", "system", "font_scale", "1.0"],
				[...base, "shell", "settings", "put", "secure", "font_weight_adjustment", "0"],
				...androidA11yResets(record.value).map((argv) => adbShellArgv(base, argv)),
				...androidScreenReaderResets(record.value).map((argv) => adbShellArgv(base, argv)),
			];
		case "locale":
			return androidLocaleResets(base, record, deps);
		case "battery":
			return [[...base, "shell", "dumpsys", "battery", "reset"]];
		case "keyboard":
			return androidKeyboardResets(base, record);
		case "passkeys":
			return androidPasskeyResets(base, record.value.previousProvider);
		default:
			return [];
	}
}

/**
 * Android passkeys: uninstall warden's provider first (uninstalling blanks both credential-provider settings), then
 * put back exactly what the device had: a value with `settings put`, an unset one with `settings delete` (never an
 * empty string, which Android reads as "no provider"). Nothing recorded = the provider never got enabled.
 */
function androidPasskeyResets(base: string[], previous: PasskeyProviderSettings | undefined): string[][] {
	const uninstall = [...base, "shell", "sh", "-c", `'pm uninstall ${PASSKEY_PROVIDER_PACKAGE} >/dev/null 2>&1; true'`];
	if (!previous) return [uninstall];
	const restore = (key: string, value: string | null) =>
		value === null
			? [...base, "shell", "settings", "delete", "secure", key]
			: adbShellArgv(base, ["settings", "put", "secure", key, value]);
	return [
		uninstall,
		restore("credential_service", previous.service),
		restore("credential_service_primary", previous.primary),
	];
}

/**
 * Android `hardware` mode disabled every IME, with the originals stashed in `warden_ime_*` global settings (and
 * recorded on the lease): put them back exactly, then drop the stash. Without a recorded state the stash itself
 * is read on the device; with neither, there is nothing to restore.
 */
function androidKeyboardResets(base: string[], record: ConditionRecord): string[][] {
	const drop = [
		[...base, "shell", "settings", "delete", "global", IME_STASH_ENABLED],
		[...base, "shell", "settings", "delete", "global", IME_STASH_DEFAULT],
	];
	const previous = record.area === "keyboard" ? record.value.previousIme : undefined;
	if (previous === undefined) {
		const script = [
			`e=$(settings get global ${IME_STASH_ENABLED})`,
			`d=$(settings get global ${IME_STASH_DEFAULT})`,
			`if [ -n "$e" ] && [ "$e" != null ]; then settings put secure enabled_input_methods "$e"; fi`,
			`if [ -n "$d" ] && [ "$d" != null ]; then settings put secure default_input_method "$d"; fi`,
		].join("; ");
		return [[...base, "shell", "sh", "-c", `'${script}'`], ...drop];
	}
	return [
		...(previous.enabled === ""
			? []
			: [adbShellArgv(base, ["settings", "put", "secure", "enabled_input_methods", previous.enabled])]),
		...(previous.default === ""
			? []
			: [adbShellArgv(base, ["settings", "put", "secure", "default_input_method", previous.default])]),
		...drop,
	];
}

/** An IANA timezone id (`Pacific/Auckland`, `Etc/GMT+12`). */
const TIMEZONE_ID = /^[A-Za-z0-9_/+-]+$/;

/**
 * Android: the timezone back to what it was (the host's when none was recorded, or the recorded value is not a
 * timezone id), and the app's locale override removed.
 */
function androidLocaleResets(
	base: readonly string[],
	record: Extract<ConditionRecord, { area: "locale" }>,
	deps: Pick<UndoDeps, "hostTimezone">
): string[][] {
	const cmds: string[][] = [];
	const { timezone, previousTimezone, locale, bundleId } = record.value;
	if (timezone !== undefined) {
		const host = deps.hostTimezone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
		const back = previousTimezone !== undefined && TIMEZONE_ID.test(previousTimezone) ? previousTimezone : host;
		cmds.push(adbShellArgv(base, ["cmd", "alarm", "set-timezone", back]));
	}
	if (locale !== undefined && bundleId !== undefined) {
		cmds.push(adbShellArgv(base, ["cmd", "locale", "set-app-locales", bundleId, "--locales", ""]));
	}
	return cmds;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Run reset commands in order; one failure line per command that exited non-zero or threw. */
async function runResets(exec: Exec, cmds: readonly string[][]): Promise<string[]> {
	const failures: string[] = [];
	for (const cmd of cmds) {
		try {
			const result = await exec(cmd);
			const alreadyGone = cmd[4] === "defaults" && iosDefaultsMissing(`${result.stderr}${result.stdout}`);
			if (result.exitCode !== 0 && !alreadyGone) failures.push(execError(cmd, result));
		} catch (error) {
			failures.push(`${cmd.join(" ")}: ${message(error)}`);
		}
	}
	return failures;
}

/** Network area: let the injected releaser stop the proxy and free its port; a throw is a failure line. */
async function releaseProxy(deps: UndoDeps, leaseId: string, record: ConditionRecord): Promise<string[]> {
	if (record.area !== "network" || !deps.releaseProxy) return [];
	try {
		await deps.releaseProxy(leaseId);
		return [];
	} catch (error) {
		return [`release proxy: ${message(error)}`];
	}
}

/**
 * Android camera: both feeds back to the grey placeholder. An emulator launched on a video source cannot go back to
 * images without a restart, so it is stopped and forgotten here: the next claim boots a fresh one in image mode (the
 * emulator is warden's own; only a `+cam` device ever has a mode file). A stop that fails leaves everything for the retry.
 */
async function resetAndroidCamera(deps: UndoDeps, serial: string): Promise<string[]> {
	const dir = cameraFeedDir(wardenHome(deps.env), serial);
	const failures: string[] = [];
	if (usesVideo(readCameraMode(dir))) {
		const { adb } = androidTools(deps.env);
		const stopped = await runResets(deps.exec, [[adb, "-s", serial, "emu", "kill"]]);
		if (stopped.length > 0) return stopped;
		forgetAndroidEmulator(deps.store, serial);
	}
	try {
		resetCameraFeeds(dir);
	} catch (error) {
		failures.push(`reset camera feeds: ${message(error)}`);
	}
	return failures;
}

/** SIGTERM the live processes `record` owns; a dead pid is skipped (already gone). */
function stopOwned(deps: UndoDeps, record: ConditionRecord): { killed: number[]; failures: string[] } {
	const out = { killed: [] as number[], failures: [] as string[] };
	for (const { pid } of record.owned) {
		if (!deps.pidAlive(pid)) continue;
		try {
			deps.kill(pid);
			out.killed.push(pid);
		} catch (error) {
			out.failures.push(`kill ${pid}: ${message(error)}`);
		}
	}
	return out;
}

/**
 * iOS areas the injected dylib serves: an app that is still running keeps reading its state file, so it goes back
 * online on the real clock with blank camera feeds and, for `passkeys`, no authenticator; the camera's staged host
 * files are then removed. The passkey store is removed per platform in `resetRecord`.
 */
const IOS_INJECTED: ReadonlySet<ConditionArea> = new Set(["clock", "network", "camera", "keyboard", "passkeys"]);

function resetIosInjected(deps: UndoDeps, udid: string, area: ConditionRecord["area"]): string[] {
	if (!IOS_INJECTED.has(area)) return [];
	const home = wardenHome(deps.env);
	const failed = neutralizeInjectState(injectStatePath(home, udid), area);
	const out = failed ? [failed] : [];
	if (area !== "camera") return out;
	try {
		clearCameraFeeds(home, udid);
	} catch (error) {
		out.push(`remove camera feeds: ${message(error)}`);
	}
	return out;
}

/** What resetting one condition record did: failure lines (empty = reset) and the owned pids stopped. */
export type ResetOutcome = { failures: string[]; killed: number[] };

/**
 * Reset one condition record on `device` (undefined = nothing on a device to reset): the area's reset
 * commands, the iOS inject-state / launch-settings cleanup, the lease's shaping proxy (`leaseId` keys its
 * handle file) and the processes the record owns. Shared by a live lease's undo and an orphan's.
 */
export async function resetRecord(
	deps: UndoDeps,
	device: { platform: Platform; id: string } | undefined,
	leaseId: string,
	record: ConditionRecord
): Promise<ResetOutcome> {
	if (device?.platform === "android" && record.area === "camera") {
		return { failures: await resetAndroidCamera(deps, device.id), killed: [] };
	}
	const cmds = device ? resetCommands(device.platform, device.id, record, deps) : [];
	const resets = await runResets(deps.exec, cmds);
	if (device?.platform === "ios") resets.push(...resetIosInjected(deps, device.id, record.area));
	// iOS has no device-side timezone or locale: only the staged launch settings go
	if (device?.platform === "ios" && record.area === "locale") {
		const failed = writeLaunchSettings(launchSettingsPath(wardenHome(deps.env), device.id), {});
		if (failed) resets.push(failed);
	}
	if (device && record.area === "passkeys" && resets.length === 0) {
		const failed = removePasskeyStore(passkeyStorePath(wardenHome(deps.env), device.id));
		if (failed) resets.push(failed);
	}
	const released = await releaseProxy(deps, leaseId, record);
	const stopped = stopOwned(deps, record);
	return { failures: [...resets, ...released, ...stopped.failures], killed: stopped.killed };
}

/**
 * Undo every condition `lease` has set on its device: reset commands per active area, owned processes
 * killed, then the row cleared. Only the lease's own device is touched (a non-device or still-pending
 * lease has none to reset). Idempotent — an area with no row costs nothing — and never throws: a reset
 * that fails keeps its row, is reported, and leaves the other areas to run.
 */
export async function undoConditions(deps: UndoDeps, lease: Lease): Promise<Result<UndoReport, UndoFailure>> {
	const report: UndoReport = { reset: [], killed: [] };
	const errors: string[] = [];
	const target = lease.resource;
	const device = target.kind === "device" && !target.id.startsWith(PENDING_PREFIX) ? target : undefined;
	for (const record of activeConditions(deps.store, lease.id)) {
		const { failures, killed } = await resetRecord(deps, device, lease.id, record);
		report.killed.push(...killed);
		if (failures.length > 0) {
			errors.push(...failures.map((f) => `${record.area}: ${f}`));
			continue;
		}
		clearCondition(deps.store, lease.id, record.area);
		report.reset.push(record.area);
	}
	return errors.length > 0 ? { success: false, error: { errors, report } } : ok(report);
}
