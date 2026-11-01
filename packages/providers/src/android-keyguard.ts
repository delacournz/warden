/**
 * Android emulator keyguard + readiness for biometrics (`+bio`) devices. Fingerprint enrollment needs a secure
 * lock (a PIN), so an enrolled emulator boots behind a lock screen and the app cannot resolve its launcher until
 * the user is unlocked. A restored snapshot can also come back with a black, unresponsive SystemUI that ignores
 * wake / dismiss / PIN input until SystemUI is restarted. Emulator serials only: never run on a foreign device.
 */

import type { Exec } from "@delacour/warden-runtime/exec";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
import { BIOMETRIC_PIN } from "./biometrics";

const SHELL_TIMEOUT_MS = 15_000;
const UNLOCK_ATTEMPTS = 3;
const UNLOCK_SETTLE_MS = 1_500;
const READY_POLL_MS = 500;

/** Keep the screen on and never time out, so the unlocked device does not lock again. */
export const STAY_AWAKE_COMMAND = "svc power stayon true; settings put system screen_off_timeout 2147483647";

/** Crashing SystemUI makes the system restart it with a fresh, responsive lock screen. */
export const SYSTEMUI_RESTART_COMMAND = "am crash com.android.systemui";

/** Pure text builders and parsers for the keyguard. */
export class KeyguardScripts {
	/** Wake, swipe the lock screen up to the PIN bouncer, type the PIN. */
	unlockCommand(): string {
		return [
			"input keyevent 224",
			"input swipe 540 2000 540 600 200",
			"sleep 1",
			`input text ${BIOMETRIC_PIN}`,
			"input keyevent 66",
		].join("; ");
	}

	/** `isKeyguardShowing=` of `dumpsys window` (API 36), `undefined` when the dump has no such line. */
	parseShowing(dump: string): boolean | undefined {
		const match = /isKeyguardShowing=(true|false)/.exec(dump);
		return match ? match[1] === "true" : undefined;
	}
}

export const keyguardScripts = new KeyguardScripts();

export type KeyguardDeps = {
	exec: Exec;
	sleep: (ms: number) => Promise<void>;
	/** the adb binary (`androidToolsLocator.locate(env).adb`) */
	adb: string;
	now?: () => number;
};

/** Keyguard + readiness of an Android emulator, over `adb shell`. */
export class AndroidKeyguard {
	constructor(private readonly deps: KeyguardDeps) {}

	/**
	 * Get past the lock screen (idempotent: nothing is typed when it is already gone) and keep the device awake.
	 * Up to three unlock attempts; before the last one SystemUI is restarted, which recovers a restored snapshot
	 * whose lock screen is black and ignores input.
	 */
	async ensureUnlocked(serial: string): AsyncResult<void> {
		if (!/^emulator-\d+$/.test(serial)) return resultFactory.err(`refusing to unlock ${serial}: emulators only`);
		for (let attempt = 1; attempt <= UNLOCK_ATTEMPTS; attempt++) {
			if (!(await this.keyguardShowing(serial))) return this.stayAwake(serial);
			if (attempt === UNLOCK_ATTEMPTS) {
				await this.shell(serial, SYSTEMUI_RESTART_COMMAND);
				await this.deps.sleep(UNLOCK_SETTLE_MS * 3);
			}
			await this.shell(serial, keyguardScripts.unlockCommand());
			await this.deps.sleep(UNLOCK_SETTLE_MS);
		}
		if (!(await this.keyguardShowing(serial))) return this.stayAwake(serial);
		return resultFactory.err(`${serial}: the keyguard is still showing after ${UNLOCK_ATTEMPTS} unlock attempts`);
	}

	/**
	 * `adb get-state` = device and the package manager answering (`pm path android`), polled for up to `timeoutMs`:
	 * `boot_completed` can precede both on a restored snapshot, and an install in that window fails `device offline`.
	 */
	async systemReady(serial: string, timeoutMs: number): AsyncResult<void> {
		const now = this.deps.now ?? Date.now;
		const deadline = now() + timeoutMs;
		let last = "no answer";
		for (;;) {
			const state = await this.deps
				.exec([this.deps.adb, "-s", serial, "get-state"], { timeoutMs: SHELL_TIMEOUT_MS })
				.catch(() => undefined);
			const adbState = state?.exitCode === 0 ? state.stdout.trim() : "unreachable";
			if (adbState === "device") {
				const pm = await this.shell(serial, "pm path android");
				if (pm.exitCode === 0 && pm.stdout.includes("package:")) return resultFactory.ok(undefined);
				last = "package manager not ready";
			} else last = `adb state ${adbState}`;
			if (now() >= deadline) return resultFactory.err(`${serial}: not ready after ${timeoutMs}ms (${last})`);
			await this.deps.sleep(READY_POLL_MS);
		}
	}

	private async stayAwake(serial: string): AsyncResult<void> {
		await this.shell(serial, STAY_AWAKE_COMMAND);
		return resultFactory.ok(undefined);
	}

	private async shell(serial: string, command: string, timeoutMs = SHELL_TIMEOUT_MS) {
		try {
			return await this.deps.exec([this.deps.adb, "-s", serial, "shell", command], { timeoutMs });
		} catch (error) {
			return { exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
		}
	}

	private async keyguardShowing(serial: string): Promise<boolean> {
		const dump = await this.shell(serial, "dumpsys window");
		return keyguardScripts.parseShowing(dump.stdout) !== false;
	}
}
