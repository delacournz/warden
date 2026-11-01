import type { DriverResult, Logger } from "@delacour/warden-driver/driver.types";
import { driverErrors } from "@delacour/warden-driver/errors";
import type { AdbSession } from "./adb-session";
import { androidArgv } from "./android-argv";
import type { Clock } from "./android-device";
import {
	type AndroidDeviceState,
	type AndroidStateStore,
	androidState,
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

/** Phone probe parsing and the wake / keyguard preparation of an attached phone. */
export class AndroidPhone {
	/**
	 * The phone facts in a boot probe's output, or `undefined` when the probe had no phone tail (a console emulator)
	 * or the qemu props say this is an emulator (`localhost:5555`, Genymotion): not a phone.
	 */
	parsePhoneFacts(stdout: string): PhoneFacts | undefined {
		const qemu = /wdn_qemu:(\S*)/.exec(stdout);
		if (!qemu || (qemu[1] ?? "").includes("1")) return undefined;
		const wake = /mWakefulness=(\w+)/.exec(stdout)?.[1];
		return { ...(wake !== undefined ? { awake: wake === "Awake" } : {}), ...this.keyguardFacts(stdout) };
	}

	/** One shell command in the session; its stdout, or "" (logged) when it failed. */
	async quiet(session: AdbSession, argv: readonly string[], log?: Logger): Promise<string> {
		const res = await session.run(androidArgv.shellCommand(argv));
		if (!res.success || res.data.exitCode !== 0) log?.(`${argv.join(" ")} failed`);
		return res.success ? res.data.stdout : "";
	}

	/**
	 * Make an attached phone usable, never unlock it: a sleeping one gets `KEYCODE_WAKEUP`; a keyguard without a
	 * credential is dismissed (`wm dismiss-keyguard`); a secure keyguard is `E_DEVICE_LOCKED` (no swipe, no PIN).
	 */
	async preparePhone(
		session: AdbSession,
		clock: Pick<Clock, "sleep">,
		facts: PhoneFacts,
		log?: Logger
	): DriverResult<void> {
		let { keyguardShowing, keyguardSecure } = facts;
		if (facts.awake === false) {
			await this.quiet(session, ["input", "keyevent", "224"], log);
			await clock.sleep(SCREEN_SETTLE_MS);
			const res = await session.run(KEYGUARD_COMMAND);
			if (res.success) {
				const read = this.keyguardFacts(res.data.stdout);
				keyguardShowing = read.keyguardShowing ?? keyguardShowing;
				keyguardSecure = read.keyguardSecure ?? keyguardSecure;
			}
		}
		if (keyguardShowing !== true) return { success: true, data: undefined };
		if (keyguardSecure === true) {
			return driverErrors.err(
				"E_DEVICE_LOCKED",
				"the phone is locked behind a PIN, pattern or password: unlock it, then retry",
				{
					retryable: false,
				}
			);
		}
		await this.quiet(session, ["wm", "dismiss-keyguard"], log);
		await clock.sleep(SCREEN_SETTLE_MS);
		return { success: true, data: undefined };
	}

	/**
	 * Rotation (`accelerometer_rotation`, `user_rotation`) and dark mode (`cmd uimode night`) are settings that
	 * outlive the driver. On a phone the originals are read and written to the state file BEFORE the first change
	 * (so a crash cannot lose them) and restored when the driver closes, the way animation scales are.
	 */
	async createSettingsGuard(deps: SettingsGuardDeps): Promise<SettingsGuard> {
		return new AndroidSettingsGuard(deps);
	}

	private flag(text: string, name: string): boolean | undefined {
		const m = new RegExp(`\\b${name}=(true|false)`).exec(text);
		return m ? m[1] === "true" : undefined;
	}

	private keyguardFacts(text: string): Pick<PhoneFacts, "keyguardShowing" | "keyguardSecure"> {
		const showing = this.flag(text, "showing");
		const secure = this.flag(text, "secure");
		return {
			...(showing !== undefined ? { keyguardShowing: showing } : {}),
			...(secure !== undefined ? { keyguardSecure: secure } : {}),
		};
	}
}

export const androidPhone = new AndroidPhone();

/** Saves the rotation / night-mode originals before the first write and puts them back on `restore`. */
export class AndroidSettingsGuard implements SettingsGuard {
	private rotation: RotationValues | undefined;
	private uimode: UimodeValue | undefined;
	private readonly remembering: { rotation: boolean; uimode: boolean };

	constructor(private readonly deps: SettingsGuardDeps) {
		this.rotation = deps.pending.rotation;
		this.uimode = deps.pending.uimode;
		this.remembering = { rotation: this.rotation === undefined, uimode: this.uimode === undefined };
	}

	async beforeRotate(): DriverResult<void> {
		const { serial, sdk, state } = this.deps;
		if (!this.remembering.rotation) return { success: true, data: undefined };
		const [accelerometer, user] = [
			await this.readSetting("accelerometer_rotation"),
			await this.readSetting("user_rotation"),
		];
		if (accelerometer === undefined || user === undefined) {
			return driverErrors.err(
				"E_REFUSED",
				`cannot read the rotation settings of ${serial}, so they could not be put back`
			);
		}
		this.remembering.rotation = false;
		const rotation: RotationValues = { accelerometer_rotation: accelerometer, user_rotation: user };
		this.rotation = rotation;
		await state?.update(serial, androidState.patchFor(sdk, { rotation }));
		return { success: true, data: undefined };
	}

	async beforeAppearance(): DriverResult<void> {
		const { session, serial, sdk, state, log } = this.deps;
		if (!this.remembering.uimode) return { success: true, data: undefined };
		const night = await androidPhone.quiet(session, ["cmd", "uimode", "night"], log);
		const mode = /Night mode:\s*(yes|no|auto)/i.exec(night)?.[1];
		if (mode === undefined) {
			return driverErrors.err("E_REFUSED", `cannot read the night mode of ${serial}, so it could not be put back`);
		}
		this.remembering.uimode = false;
		const uimode = mode.toLowerCase() as UimodeValue;
		this.uimode = uimode;
		await state?.update(serial, androidState.patchFor(sdk, { uimode }));
		return { success: true, data: undefined };
	}

	async restore(): Promise<void> {
		const { session, serial, sdk, state, log } = this.deps;
		const commands = this.restoreCommands();
		if (commands.length === 0) return;
		let failed = false;
		for (const argv of commands) {
			const res = await session.run(androidArgv.shellCommand(argv));
			if (!res.success || res.data.exitCode !== 0) failed = true;
		}
		if (failed) {
			log?.("could not restore the rotation / night mode; the next driver on this device will");
			return;
		}
		this.rotation = undefined;
		this.uimode = undefined;
		await state?.update(serial, androidState.patchFor(sdk, { rotation: undefined, uimode: undefined }));
	}

	private restoreCommands(): string[][] {
		const commands: string[][] = [];
		const { rotation, uimode } = this;
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
		return commands;
	}

	private async readSetting(key: string): Promise<string | undefined> {
		const { session, log } = this.deps;
		const text = (await androidPhone.quiet(session, ["settings", "get", "system", key], log)).trim();
		return SETTING_VALUE.test(text) ? text : undefined;
	}
}
