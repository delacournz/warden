import type { Result } from "@delacour/warden-types/result";
import type { DriverError, HardwareButton, KeyName, Point } from "../driver.types";
import { driverErr } from "../errors";

/**
 * Pure argv builders for the Android driver. The `string[]` ones run INSIDE the persistent
 * `adb shell` session (joined by `shellCommand`, which quotes every word); `screencapArgv` is a HOST
 * argv: PNG bytes must never go through the text session (use `adb exec-out`, like `batch/screenshot.ts`).
 */

const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** POSIX single-quote a word for the device shell (`'` becomes `'\''`). Safe words stay bare. */
export function shellQuote(word: string): string {
	if (word === "") return "''";
	if (SAFE_WORD.test(word)) return word;
	return `'${word.replace(/'/g, "'\\''")}'`;
}

/** One shell command line from an argv. */
export function shellCommand(argv: readonly string[]): string {
	return argv.map(shellQuote).join(" ");
}

const px = (value: number): string => String(Math.round(value));

export function tapArgv(point: Point): string[] {
	return ["input", "tap", px(point.x), px(point.y)];
}

export const DEFAULT_SWIPE_MS = 300;
export const DEFAULT_LONG_PRESS_MS = 600;

export function swipeArgv(from: Point, to: Point, durationMs: number = DEFAULT_SWIPE_MS): string[] {
	return ["input", "swipe", px(from.x), px(from.y), px(to.x), px(to.y), String(Math.max(1, Math.round(durationMs)))];
}

/** `input` has no long-press verb: a swipe that stays in place for the duration. */
export function longPressArgv(point: Point, durationMs: number = DEFAULT_LONG_PRESS_MS): string[] {
	return swipeArgv(point, point, durationMs);
}

export function keyeventArgv(keycode: number): string[] {
	return ["input", "keyevent", String(keycode)];
}

/** `HardwareButton` to Android keycode; `shake` has no keycode. */
export function buttonKeycode(button: HardwareButton): number | undefined {
	switch (button) {
		case "home":
			return 3;
		case "back":
			return 4;
		case "volumeUp":
			return 24;
		case "volumeDown":
			return 25;
		case "lock":
			return 26;
		case "shake":
			return undefined;
	}
}

export function keyNameKeycode(key: KeyName): number {
	switch (key) {
		case "Enter":
			return 66;
		case "Backspace":
			return 67;
		case "Tab":
			return 61;
		case "Space":
			return 62;
		case "Escape":
			return 111;
		case "Delete":
			return 112;
		case "Up":
			return 19;
		case "Down":
			return 20;
		case "Left":
			return 21;
		case "Right":
			return 22;
	}
}

/**
 * `input text`: printable ASCII only. Spaces become `%s` (the one escape `input` understands); a literal
 * `%s` cannot be expressed so it is rejected rather than silently turned into a space. Anything else
 * is `E_UNSUPPORTED_TEXT` (the caller may fall back to the clipboard). Empty text yields an empty argv.
 */
export function textArgv(text: string): Result<string[], DriverError> {
	if (text === "") return { success: true, data: [] };
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if (code < 0x20 || code > 0x7e) {
			return driverErr(
				"E_UNSUPPORTED_TEXT",
				`Android \`input text\` only types printable ASCII; got U+${code.toString(16).toUpperCase().padStart(4, "0")}`
			);
		}
	}
	if (text.includes("%s")) {
		return driverErr("E_UNSUPPORTED_TEXT", "Android `input text` cannot type a literal `%s` (it means a space)");
	}
	return { success: true, data: ["input", "text", text.replace(/ /g, "%s")] };
}

export function startUrlArgv(url: string): string[] {
	return ["am", "start", "-a", "android.intent.action.VIEW", "-d", url];
}

/** Launch a package's launcher activity without knowing its activity name. */
export function monkeyLaunchArgv(packageName: string): string[] {
	return ["monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"];
}

export function forceStopArgv(packageName: string): string[] {
	return ["am", "force-stop", packageName];
}

export function pmClearArgv(packageName: string): string[] {
	return ["pm", "clear", packageName];
}

/** Turn all three animation scales off (flake source in e2e). */
export function animationScaleArgvs(): string[][] {
	return ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"].map((key) => [
		"settings",
		"put",
		"global",
		key,
		"0",
	]);
}

/** Host argv: `adb -s <serial> exec-out screencap -p` (binary PNG on stdout). */
export function screencapArgv(adb: string, serial: string): string[] {
	return [adb, "-s", serial, "exec-out", "screencap", "-p"];
}

/** `getprop <key>` (boot flag, sdk level, model). */
export function getpropArgv(key: string): string[] {
	return ["getprop", key];
}

export const WM_SIZE_ARGV: readonly string[] = ["wm", "size"];
export const WM_DENSITY_ARGV: readonly string[] = ["wm", "density"];

export const DUMP_FILE_PATH = "/sdcard/warden-ui.xml";

/** Route 1: dump straight to the session's stdout. */
export function dumpStdoutArgv(): string[] {
	return ["uiautomator", "dump", "/dev/stdout"];
}

/** Route 2 (host argv): `exec-out` gives uiautomator a tty-less stdout it accepts as `/dev/tty`. */
export function dumpTtyHostArgv(adb: string, serial: string): string[] {
	return [adb, "-s", serial, "exec-out", "uiautomator", "dump", "/dev/tty"];
}

/** Route 3: dump to a file on the device then `cat` it (works on every image). */
export function dumpFileCommand(path: string = DUMP_FILE_PATH): string {
	return `${shellCommand(["uiautomator", "dump", path])} >/dev/null 2>&1; ${shellCommand(["cat", path])}`;
}

/** Host argv: `adb -s <serial> install -r <apk>`. */
export function installArgv(adb: string, serial: string, apkPath: string): string[] {
	return [adb, "-s", serial, "install", "-r", apkPath];
}

export function uninstallArgv(adb: string, serial: string, packageName: string): string[] {
	return [adb, "-s", serial, "uninstall", packageName];
}

/** Exit 0 and `package:/…` when installed, exit 1 and nothing otherwise. */
export function pmPathArgv(packageName: string): string[] {
	return ["pm", "path", packageName];
}

/** Exit 0 and the pids when running (API 24+). */
export function pidofArgv(packageName: string): string[] {
	return ["pidof", packageName];
}

export type RotationValue = 0 | 1 | 2 | 3;

/** Lock auto-rotate off, then pin the rotation. */
export function rotationArgvs(rotation: RotationValue): string[][] {
	return [
		["settings", "put", "system", "accelerometer_rotation", "0"],
		["settings", "put", "system", "user_rotation", String(rotation)],
	];
}

export function userRotationArgv(): string[] {
	return ["settings", "get", "system", "user_rotation"];
}

export function uimodeGetArgv(): string[] {
	return ["cmd", "uimode", "night"];
}

export function uimodeSetArgv(dark: boolean): string[] {
	return ["cmd", "uimode", "night", dark ? "yes" : "no"];
}

/** `input keycombination` (API 33+): modifiers first, the key last. */
export function keycombinationArgv(keycodes: readonly number[]): string[] {
	return ["input", "keycombination", ...keycodes.map(String)];
}

export function modifierKeycode(modifier: "shift" | "cmd" | "alt" | "ctrl"): number {
	switch (modifier) {
		case "shift":
			return 59;
		case "cmd":
			return 117;
		case "alt":
			return 57;
		case "ctrl":
			return 113;
	}
}
