/**
 * Android fingerprint enrollment for the golden build emulator: set a screen-lock PIN, open the system
 * enrollment wizard, answer its screens (PIN entry, Next/Agree/Done) and present the virtual finger until
 * `dumpsys fingerprint` reports one enrolled. Slow (tens of seconds), so it runs once in the snapshot build
 * and claims start enrolled. Idempotent: an already enrolled device is left alone. Emulator serials only.
 */
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { BIOMETRIC_FINGER_ID, BIOMETRIC_PIN } from "../biometrics";
import type { Exec } from "../exec";

const SHELL_TIMEOUT_MS = 15_000;
const DUMP_PATH = "/sdcard/warden-ui.xml";
const KEYCODE_ENTER = "66";
const KEYCODE_HOME = "3";
const SETTINGS_PACKAGE = "com.android.settings";

/** Wizard buttons answered, by whole text. `Skip` / `Cancel` / `Not now` are deliberately absent. */
const WIZARD_BUTTONS = /^(next|more|agree|i agree|start|done|got it|ok|continue)$/i;

/**
 * Whether `dumpsys fingerprint` lists an enrolled fingerprint: the JSON `"prints":[{"id":0,"count":N,…}]` of Android 10+
 * (`count` = fingerprints enrolled for that user) or the older `Enrolled fingerprints: N` / `prints: N` lines.
 */
export function parseFingerprintEnrolled(dump: string): boolean {
	const counts = [...dump.matchAll(/"count"\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
	if (counts.length > 0) return counts.some((n) => n > 0);
	const legacy = [...dump.matchAll(/(?:enrolled fingerprints?|prints)\s*[:=]\s*(\d+)/gi)].map((m) => Number(m[1]));
	return legacy.some((n) => n > 0);
}

export type TapTarget = { label: string; x: number; y: number };

/** Centre of the first wizard button in a `uiautomator dump`. */
export function findTapTarget(xml: string): TapTarget | undefined {
	for (const match of xml.matchAll(/<node\b[^>]*>/g)) {
		const tag = match[0];
		const label = /\btext="([^"]*)"/.exec(tag)?.[1]?.trim();
		const bounds = /\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(tag);
		if (!label || !bounds || !WIZARD_BUTTONS.test(label)) continue;
		const [x1, y1, x2, y2] = bounds.slice(1).map(Number) as [number, number, number, number];
		return { label, x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) };
	}
	return undefined;
}

/** The lock-screen credential entry the wizard asks before it starts. */
export function isPinEntry(xml: string): boolean {
	return /resource-id="[^"]*(password_entry|pin_entry|pinEntry)[^"]*"/.test(xml);
}

export type EnrollDeps = {
	exec: Exec;
	sleep: (ms: number) => Promise<void>;
	/** the adb binary (`androidTools(env).adb`) */
	adb: string;
	/** wizard rounds before giving up (default 60) */
	maxSteps?: number;
	/** pause after each round (default 700 ms) */
	stepMs?: number;
};

export async function enrollFingerprint(deps: EnrollDeps, serial: string): AsyncResult<{ alreadyEnrolled: boolean }> {
	if (!/^emulator-\d+$/.test(serial)) return err(`refusing to enroll a fingerprint on ${serial}: emulators only`);
	const { adb } = deps;
	const shell = (...args: string[]) =>
		deps.exec([adb, "-s", serial, "shell", ...args], { timeoutMs: SHELL_TIMEOUT_MS });
	const enrolled = async () => parseFingerprintEnrolled((await shell("dumpsys", "fingerprint")).stdout);

	if (await enrolled()) return ok({ alreadyEnrolled: true });

	const pin = await shell("locksettings", "set-pin", BIOMETRIC_PIN);
	if (pin.exitCode !== 0 && !/already/i.test(`${pin.stdout}${pin.stderr}`)) {
		return err(`${serial}: locksettings set-pin failed: ${`${pin.stdout}${pin.stderr}`.trim().slice(0, 200)}`);
	}
	const started = await shell("am", "start", "-a", "android.settings.FINGERPRINT_ENROLL");
	if (started.exitCode !== 0) return err(`${serial}: cannot open the fingerprint wizard: ${started.stderr.trim()}`);

	const steps = deps.maxSteps ?? 60;
	for (let i = 0; i < steps; i++) {
		await shell("uiautomator", "dump", DUMP_PATH);
		const xml = (await shell("cat", DUMP_PATH)).stdout;
		if (isPinEntry(xml)) {
			await shell("input", "text", BIOMETRIC_PIN);
			await shell("input", "keyevent", KEYCODE_ENTER);
		} else {
			const target = findTapTarget(xml);
			if (target) await shell("input", "tap", String(target.x), String(target.y));
		}
		await deps.exec([adb, "-s", serial, "emu", "finger", "touch", String(BIOMETRIC_FINGER_ID)], {
			timeoutMs: SHELL_TIMEOUT_MS,
		});
		await deps.sleep(deps.stepMs ?? 700);
		if (await enrolled()) {
			await shell("am", "force-stop", SETTINGS_PACKAGE);
			await shell("input", "keyevent", KEYCODE_HOME);
			return ok({ alreadyEnrolled: false });
		}
	}
	return err(`${serial}: fingerprint enrollment did not finish in ${steps} wizard rounds`);
}
