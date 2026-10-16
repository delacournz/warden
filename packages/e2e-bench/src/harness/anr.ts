import { type AsyncResult, ok } from "@delacour/warden-types/result";
import { type Exec, runOk } from "./exec";

/** The focused window line `dumpsys window` prints while an ANR dialog is up. */
const ANR_WINDOW_RE = /Application Not Responding: ([\w.]+)/;
/** `uiautomator dump` node for the dialog's "Close app" button, with its `[l,t][r,b]` bounds. */
const CLOSE_RE = /resource-id="android:id\/aerr_close"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/;

/** The package an "isn't responding" dialog is about, from `dumpsys window` output. */
export function anrPackage(dumpsys: string): string | undefined {
	return ANR_WINDOW_RE.exec(dumpsys)?.[1];
}

/** Centre of the dialog's "Close app" button in a `uiautomator dump`, if the dialog is in it. */
export function anrCloseCenter(dump: string): { x: number; y: number } | undefined {
	const m = CLOSE_RE.exec(dump);
	if (m === null) return undefined;
	const [l, t, r, b] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
	return { x: Math.round((l + r) / 2), y: Math.round((t + b) / 2) };
}

export type AnrOutcome = { dismissed: false } | { dismissed: true; packageName: string };

/**
 * Dismisses an Android "app isn't responding" dialog if one is in the foreground: it survives
 * `am force-stop` and every framework's own launch, so once it appears every later test of every
 * framework fails at its first assertion. Taps "Close app" (BACK, which means "Wait", as a fallback).
 */
export async function dismissAnr(exec: Exec, serial: string): AsyncResult<AnrOutcome> {
	const windows = await runOk(exec, "adb", ["-s", serial, "shell", "dumpsys", "window", "windows"]);
	if (!windows.success) return windows;
	const packageName = anrPackage(windows.data.stdout);
	if (packageName === undefined) return ok({ dismissed: false });
	const dump = await exec.run("adb", ["-s", serial, "exec-out", "uiautomator", "dump", "/dev/tty"]);
	const center = anrCloseCenter(dump.stdout);
	const tap = center
		? ["-s", serial, "shell", "input", "tap", String(center.x), String(center.y)]
		: ["-s", serial, "shell", "input", "keyevent", "BACK"];
	const pressed = await runOk(exec, "adb", tap);
	if (!pressed.success) return pressed;
	return ok({ dismissed: true, packageName });
}

/**
 * Android's `hide_error_dialogs` global setting: with it on, an ANR'd or crashed app is closed
 * silently instead of parking an "isn't responding" dialog over every later test. Set for the run on
 * the leased emulator and cleared again at release.
 */
export async function hideErrorDialogs(exec: Exec, serial: string, on: boolean): AsyncResult<void> {
	const ran = await runOk(exec, "adb", [
		"-s",
		serial,
		"shell",
		"settings",
		"put",
		"global",
		"hide_error_dialogs",
		on ? "1" : "0",
	]);
	return ran.success ? ok(undefined) : ran;
}
