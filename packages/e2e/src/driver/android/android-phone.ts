import type { DriverResult, Logger } from "../driver.types";
import { driverErr } from "../errors";
import type { AdbSession } from "./adb-session";
import { shellCommand } from "./android-argv";
import type { Clock } from "./android-device";
import {
	type AndroidDeviceState,
	type AndroidStateStore,
	patchFor,
	type RotationValues,
	type UimodeValue,
} from "./android-state";

/**
 * Safety for real phones (WDN-PHY-2.4). A phone is somebody's device: warden wakes it, refuses to touch a locked
 * one, and anything it changes (rotation, dark mode, animation scales) is saved first and put back on close.
 */

/** Wait after a wake or a keyguard dismiss before looking at the screen again. */
const SCREEN_SETTLE_MS = 400;

/** `ro.boot.qemu` / `ro.kernel.qemu` joined (empty on hardware), the power state and the keyguard, as the tail of the boot probe. */
export const PHONE_PROBE_TAIL =
	`echo "wdn_qemu:$(getprop ro.boot.qemu)$(getprop ro.kernel.qemu)"; ` +
	`dumpsys power | grep -E 'mWakefulness='; ` +
	`dumpsys window policy | grep -E 'showing=|secure='`;

/** `dumpsys window policy`'s keyguard lines: `showing=true`, `secure=true`. */
export const KEYGUARD_COMMAND = "dumpsys window policy | grep -E 'showing=|secure='";

/** What the phone-probe tail found out; every field is `undefined` when `dumpsys` printed nothing parseable. */
export type PhoneFacts = { awake?: boolean; keyguardShowing?: boolean; keyguardSecure?: boolean };

function flag(text: string, name: string): boolean | undefined {
	const m = new RegExp(`\\b${name}=(true|false)`).exec(text);
	return m ? m[1] === "true" : undefined;
}

function keyguardFacts(text: string): Pick<PhoneFacts, "keyguardShowing" | "keyguardSecure"> {
	const showing = flag(text, "showing");
	const secure = flag(text, "secure");
	return {
		...(showing !== undefined ? { keyguardShowing: showing } : {}),
		...(secure !== undefined ? { keyguardSecure: secure } : {}),
	};
}

/**
 * The phone facts in a boot probe's output, or `undefined` when the probe had no phone tail (a console emulator)
 * or the qemu props say this is an emulator (`localhost:5555`, Genymotion): not a phone.
 */
export function parsePhoneFacts(stdout: string): PhoneFacts | undefined {
	const qemu = /wdn_qemu:(\S*)/.exec(stdout);
	if (!qemu || (qemu[1] ?? "").includes("1")) return undefined;
	const wake = /mWakefulness=(\w+)/.exec(stdout)?.[1];
	return { ...(wake !== undefined ? { awake: wake === "Awake" } : {}), ...keyguardFacts(stdout) };
}

async function quiet(session: AdbSession, argv: readonly string[], log?: Logger): Promise<string> {
	const res = await session.run(shellCommand(argv));
	if (!res.success || res.data.exitCode !== 0) log?.(`${argv.join(" ")} failed`);
	return res.success ? res.data.stdout : "";
}

/**
 * Make an attached phone usable, never unlock it: a sleeping one gets `KEYCODE_WAKEUP`; a keyguard without a
 * credential is dismissed (`wm dismiss-keyguard`); a secure keyguard is `E_DEVICE_LOCKED` (no swipe, no PIN).
 */
export async function preparePhone(
	session: AdbSession,
	clock: Pick<Clock, "sleep">,
	facts: PhoneFacts,
	log?: Logger
): DriverResult<void> {
	let { keyguardShowing, keyguardSecure } = facts;
	if (facts.awake === false) {
		await quiet(session, ["input", "keyevent", "224"], log);
		await clock.sleep(SCREEN_SETTLE_MS);
		const res = await session.run(KEYGUARD_COMMAND);
		if (res.success) {
			const read = keyguardFacts(res.data.stdout);
			keyguardShowing = read.keyguardShowing ?? keyguardShowing;
			keyguardSecure = read.keyguardSecure ?? keyguardSecure;
		}
	}
	if (keyguardShowing !== true) return { success: true, data: undefined };
	if (keyguardSecure === true) {
		return driverErr(
			"E_DEVICE_LOCKED",
			"the phone is locked behind a PIN, pattern or password: unlock it, then retry",
			{
				retryable: false,
			}
		);
	}
	await quiet(session, ["wm", "dismiss-keyguard"], log);
	await clock.sleep(SCREEN_SETTLE_MS);
	return { success: true, data: undefined };
}

export type SettingsGuard = {
	/** before the first rotation write: save the current rotation settings (once); an error means do not write */
	beforeRotate(): DriverResult<void>;
	/** before the first `cmd uimode night` write: save the current mode (once) */
	beforeAppearance(): DriverResult<void>;
	/** put everything saved back (once); a failed restore leaves the originals in the state file for the next driver */
	restore(): Promise<void>;
};

export type SettingsGuardDeps = {
	session: AdbSession;
	serial: string;
	sdk: number | undefined;
	/** originals a process that died left in the state file */
	pending: Pick<AndroidDeviceState, "rotation" | "uimode">;
	state?: AndroidStateStore;
	log?: Logger;
};

const SETTING_VALUE = /^(null|\d)$/;

/**
 * Rotation (`accelerometer_rotation`, `user_rotation`) and dark mode (`cmd uimode night`) are settings that
 * outlive the driver. On a phone the originals are read and written to the state file BEFORE the first change
 * (so a crash cannot lose them) and restored when the driver closes, the way animation scales are.
 */
export async function createSettingsGuard(deps: SettingsGuardDeps): Promise<SettingsGuard> {
	const { session, serial, sdk, state, log } = deps;
	let rotation: RotationValues | undefined = deps.pending.rotation;
	let uimode: UimodeValue | undefined = deps.pending.uimode;
	const remembering = { rotation: rotation === undefined, uimode: uimode === undefined };

	async function readSetting(key: string): Promise<string | undefined> {
		const text = (await quiet(session, ["settings", "get", "system", key], log)).trim();
		return SETTING_VALUE.test(text) ? text : undefined;
	}

	return {
		async beforeRotate() {
			if (!remembering.rotation) return { success: true, data: undefined };
			const [accelerometer, user] = [await readSetting("accelerometer_rotation"), await readSetting("user_rotation")];
			if (accelerometer === undefined || user === undefined) {
				return driverErr("E_REFUSED", `cannot read the rotation settings of ${serial}, so they could not be put back`);
			}
			remembering.rotation = false;
			rotation = { accelerometer_rotation: accelerometer, user_rotation: user };
			await state?.update(serial, patchFor(sdk, { rotation }));
			return { success: true, data: undefined };
		},

		async beforeAppearance() {
			if (!remembering.uimode) return { success: true, data: undefined };
			const mode = /Night mode:\s*(yes|no|auto)/i.exec(await quiet(session, ["cmd", "uimode", "night"], log))?.[1];
			if (mode === undefined) {
				return driverErr("E_REFUSED", `cannot read the night mode of ${serial}, so it could not be put back`);
			}
			remembering.uimode = false;
			uimode = mode.toLowerCase() as UimodeValue;
			await state?.update(serial, patchFor(sdk, { uimode }));
			return { success: true, data: undefined };
		},

		async restore() {
			const commands: string[][] = [];
			if (rotation) {
				for (const key of ["accelerometer_rotation", "user_rotation"] as const) {
					commands.push(
						rotation[key] === "null"
							? ["settings", "delete", "system", key]
							: ["settings", "put", "system", key, rotation[key]]
					);
				}
			}
			if (uimode) commands.push(["cmd", "uimode", "night", uimode]);
			if (commands.length === 0) return;
			let failed = false;
			for (const argv of commands) {
				const res = await session.run(shellCommand(argv));
				if (!res.success || res.data.exitCode !== 0) failed = true;
			}
			if (failed) {
				log?.("could not restore the rotation / night mode; the next driver on this device will");
				return;
			}
			rotation = undefined;
			uimode = undefined;
			await state?.update(serial, patchFor(sdk, { rotation: undefined, uimode: undefined }));
		},
	};
}
