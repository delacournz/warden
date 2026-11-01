import type { LatLon } from "@delacour/warden-config/conditions.types";
import { geoMath } from "@delacour/warden-driver/conditions/geo";
import type { DriverError, HardwareButton, KeyName, Point } from "@delacour/warden-driver/driver.types";
import { driverErrors } from "@delacour/warden-driver/errors";
import type { GesturePlan } from "@delacour/warden-driver/gesture-geometry";
import type { Result } from "@delacour/warden-types/result";

/**
 * Pure argv builders for the Android driver. The `string[]` ones run INSIDE the persistent
 * `adb shell` session (joined by `shellCommand`, which quotes every word); `screencapArgv` is a HOST
 * argv: PNG bytes must never go through the text session (use `adb exec-out`, like `batch/screenshot.ts`).
 */

const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

export const DEFAULT_SWIPE_MS = 300;

export const DEFAULT_LONG_PRESS_MS = 600;

export type MotionAction = "DOWN" | "MOVE" | "UP" | "CANCEL";

/** Lowest sdk with `input motionevent` (Android 8.0). */
export const MOTIONEVENT_MIN_SDK = 26;

/** An id no enrollment holds: the emulator reports a non-matching touch. */
export const UNENROLLED_FINGER_ID = 99;

/** `input keycombination` (and so select-all by Ctrl+A) exists from Android 13. */
export const SELECT_ALL_MIN_SDK = 33;

export const DRAG_STEPS = 8;

export type DragTiming = { pressMs: number; durationMs: number; releaseMs: number; steps?: number };

/** Most MOVEs a one-finger gesture line sends: each `input motionevent` is a process start (~100+ ms). */
export const GESTURE_LINE_MAX_MOVES = 12;

/** Keycodes per `input keyevent` call; more are chunked into further calls. */
export const KEYEVENT_CHUNK = 32;

/** The three global settings that scale animations (flake source in e2e), in the order they are read and saved. */
export const ANIMATION_SETTINGS = [
	"window_animation_scale",
	"transition_animation_scale",
	"animator_duration_scale",
] as const;

export type AnimationSetting = (typeof ANIMATION_SETTINGS)[number];

/** A value per animation setting as `settings get global` prints it: a number, or `null` when never set. */
export type AnimationValues = Record<AnimationSetting, string>;

export const WM_SIZE_ARGV: readonly string[] = ["wm", "size"];

export const WM_DENSITY_ARGV: readonly string[] = ["wm", "density"];

export const DUMP_FILE_PATH = "/sdcard/warden-ui.xml";

export type RotationValue = 0 | 1 | 2 | 3;

const KEYCODE_A = 29;

export class AndroidArgv {
	/** POSIX single-quote a word for the device shell (`'` becomes `'\''`). Safe words stay bare. */
	shellQuote(word: string): string {
		if (word === "") return "''";
		if (SAFE_WORD.test(word)) return word;
		return `'${word.replace(/'/g, "'\\''")}'`;
	}

	/** One shell command line from an argv. */
	shellCommand(argv: readonly string[]): string {
		return argv.map((word) => this.shellQuote(word)).join(" ");
	}

	private px(value: number): string {
		return String(Math.round(value));
	}

	tapArgv(point: Point): string[] {
		return ["input", "tap", this.px(point.x), this.px(point.y)];
	}

	swipeArgv(from: Point, to: Point, durationMs: number = DEFAULT_SWIPE_MS): string[] {
		return [
			"input",
			"swipe",
			this.px(from.x),
			this.px(from.y),
			this.px(to.x),
			this.px(to.y),
			String(Math.max(1, Math.round(durationMs))),
		];
	}

	/** `input motionevent <action> x y` (Android 8 / sdk 26+): one touch event of a held gesture. */
	motionEventArgv(action: MotionAction, point: Point): string[] {
		return ["input", "motionevent", action, this.px(point.x), this.px(point.y)];
	}

	/** Host-side `adb -s <serial> emu finger touch <id>`: the emulator console presents fingerprint `id` to the sensor. */
	emuFingerTouchArgv(adb: string, serial: string, fingerId: number): string[] {
		return [adb, "-s", serial, "emu", "finger", "touch", String(fingerId)];
	}

	dumpsysFingerprintArgv(): string[] {
		return ["dumpsys", "fingerprint"];
	}

	/** Emulator serials (`emulator-5554`); the console commands exist nowhere else. */
	isEmulatorSerial(serial: string): boolean {
		return /^emulator-\d+$/.test(serial);
	}

	/** Fractional seconds for toybox `sleep` (`0.500`). */
	sleepArgv(ms: number): string[] {
		return ["sleep", (Math.max(0, ms) / 1000).toFixed(3)];
	}

	/**
	 * One shell line for a hold-then-move drag: DOWN at `from`, sleep `pressMs`, `steps` MOVEs interpolated over
	 * `durationMs`, sleep `releaseMs`, UP at `to`. Chained with `&&`; if anything fails after DOWN the finger is
	 * lifted with CANCEL and the line exits 1. Each `input` is a process start, so the sleeps are lower bounds.
	 */
	dragMotionCommand(from: Point, to: Point, timing: DragTiming): string {
		const steps = Math.max(1, timing.steps ?? DRAG_STEPS);
		const parts: string[][] = [this.motionEventArgv("DOWN", from), this.sleepArgv(timing.pressMs)];
		for (let i = 1; i <= steps; i++) {
			const t = i / steps;
			parts.push(
				this.motionEventArgv("MOVE", { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }),
				this.sleepArgv(timing.durationMs / steps)
			);
		}
		parts.push(this.sleepArgv(timing.releaseMs), this.motionEventArgv("UP", to));
		const cancel = this.shellCommand(this.motionEventArgv("CANCEL", to));
		return `${parts.map((argv) => this.shellCommand(argv)).join(" && ")} || (${cancel}; exit 1)`;
	}

	/**
	 * One shell line for a one-finger `GesturePlan` (the fallback when `warden-uiad` is not there): DOWN at the first
	 * frame, sleep `holdMs`, at most `maxMoves` MOVEs at evenly spaced frame indices (the last frame always among
	 * them, the sleeps between sum to the plan's travel time), sleep `releaseMs`, UP at the last frame. Like
	 * `dragMotionCommand`, a failure after DOWN lifts the finger with CANCEL and exits 1. Needs one path.
	 */
	gestureMotionCommand(plan: GesturePlan, maxMoves: number = GESTURE_LINE_MAX_MOVES): string {
		const path = plan.paths[0] ?? [];
		const first = path[0] ?? { x: 0, y: 0 };
		const last = path.at(-1) ?? first;
		const intervals = path.length - 1;
		const count = Math.min(Math.max(1, Math.floor(maxMoves)), Math.max(0, intervals));
		const travelMs = Math.max(0, intervals) * plan.frameMs;
		const parts: string[][] = [this.motionEventArgv("DOWN", first), this.sleepArgv(plan.holdMs)];
		for (let k = 1; k <= count; k++) {
			const at = path[Math.round((k * intervals) / count)] ?? last;
			parts.push(this.sleepArgv(travelMs / count), this.motionEventArgv("MOVE", at));
		}
		parts.push(this.sleepArgv(plan.releaseMs), this.motionEventArgv("UP", last));
		const cancel = this.shellCommand(this.motionEventArgv("CANCEL", last));
		return `${parts.map((argv) => this.shellCommand(argv)).join(" && ")} || (${cancel}; exit 1)`;
	}

	/** `input` has no long-press verb: a swipe that stays in place for the duration. */
	longPressArgv(point: Point, durationMs: number = DEFAULT_LONG_PRESS_MS): string[] {
		return this.swipeArgv(point, point, durationMs);
	}

	keyeventArgv(keycode: number): string[] {
		return ["input", "keyevent", String(keycode)];
	}

	/** `times` presses of one keycode as `input keyevent` argvs (one process start per chunk instead of per key). */
	keyRepeatArgvs(keycode: number, times: number): string[][] {
		const argvs: string[][] = [];
		for (let left = Math.max(0, Math.floor(times)); left > 0; left -= KEYEVENT_CHUNK) {
			argvs.push(["input", "keyevent", ...Array<string>(Math.min(left, KEYEVENT_CHUNK)).fill(String(keycode))]);
		}
		return argvs;
	}

	/** `HardwareButton` to Android keycode; `shake` has no keycode. */
	buttonKeycode(button: HardwareButton): number | undefined {
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

	keyNameKeycode(key: KeyName): number {
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
	 * Split `text` into the pieces that are each safe for ONE `input text` call. `input text` turns `%s` into a
	 * space and treats `%` as an escape start (the next character is consumed by the escape check, so `%%s` and
	 * `50% off` come out wrong). A `%` followed by a space or an `s` is therefore the last character of its piece:
	 * the next call starts clean, and the pieces are typed back to back.
	 */
	private splitForInputText(text: string): string[] {
		const pieces: string[] = [];
		let current = "";
		for (let i = 0; i < text.length; i++) {
			const ch = text.charAt(i);
			current += ch;
			const next = text.charAt(i + 1);
			if (ch === "%" && (next === " " || next === "s")) {
				pieces.push(current);
				current = "";
			}
		}
		if (current !== "") pieces.push(current);
		return pieces;
	}

	/**
	 * `input text` argvs for `text`: printable ASCII only, anything else is `E_UNSUPPORTED_TEXT` (no unicode path
	 * without an IME or app helper). Spaces become `%s` (the one escape `input` understands) and a literal `%`
	 * before a space or `s` is typed by splitting into separate calls (see {@link splitForInputText}); quoting
	 * for the shell is {@link shellCommand}'s job. Empty text yields no argv.
	 */
	textArgvs(text: string): Result<string[][], DriverError> {
		for (const ch of text) {
			const code = ch.codePointAt(0) ?? 0;
			if (code < 0x20 || code > 0x7e) {
				return driverErrors.err(
					"E_UNSUPPORTED_TEXT",
					`Android \`input text\` only types printable ASCII; got U+${code.toString(16).toUpperCase().padStart(4, "0")}`
				);
			}
		}
		return {
			success: true,
			data: this.splitForInputText(text).map((piece) => ["input", "text", piece.replace(/ /g, "%s")]),
		};
	}

	/** `am start` a VIEW intent for `url`; `packageName` (`-p`) pins it to the app under test instead of any handler. */
	startUrlArgv(url: string, packageName?: string): string[] {
		const argv = ["am", "start", "-a", "android.intent.action.VIEW", "-d", url];
		return packageName === undefined ? argv : [...argv, "-p", packageName];
	}

	/** Launch a package's launcher activity without knowing its activity name. */
	monkeyLaunchArgv(packageName: string): string[] {
		return ["monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"];
	}

	/** The launcher activity of a package; `--brief` prints the component (`pkg/.Activity`) on its last line. */
	resolveLauncherArgv(packageName: string): string[] {
		return ["cmd", "package", "resolve-activity", "--brief", "-c", "android.intent.category.LAUNCHER", packageName];
	}

	/**
	 * Start a known component and wait (`-W`) until its first frame is drawn; `stop` (`-S`) force-stops the app first, so
	 * a relaunch is one round trip. Prints `Status`, `LaunchState` and `TotalTime`. The intent is the launcher's own
	 * (MAIN + LAUNCHER, what `monkey` sends): it matches a running task's root, so without `-S` the app is brought to the
	 * front with its state, where a bare `-n` intent can stack a second instance on top.
	 */
	startComponentArgv(component: string, options: { stop: boolean }): string[] {
		return [
			"am",
			"start",
			"-W",
			...(options.stop ? ["-S"] : []),
			"-a",
			"android.intent.action.MAIN",
			"-c",
			"android.intent.category.LAUNCHER",
			"-n",
			component,
		];
	}

	forceStopArgv(packageName: string): string[] {
		return ["am", "force-stop", packageName];
	}

	pmClearArgv(packageName: string): string[] {
		return ["pm", "clear", packageName];
	}

	/** Turn all three animation scales off. */
	animationScaleArgvs(): string[][] {
		return ANIMATION_SETTINGS.map((key) => ["settings", "put", "global", key, "0"]);
	}

	/** Read all three animation scales, one value per output line. */
	animationReadArgvs(): string[][] {
		return ANIMATION_SETTINGS.map((key) => ["settings", "get", "global", key]);
	}

	/** Put saved scales back: a value is `put` again, a setting that was never set (`null`) is deleted. */
	animationRestoreArgvs(values: AnimationValues): string[][] {
		return ANIMATION_SETTINGS.map((key) =>
			values[key] === "null" ? ["settings", "delete", "global", key] : ["settings", "put", "global", key, values[key]]
		);
	}

	/** Host argv: `adb -s <serial> exec-out screencap -p` (binary PNG on stdout). */
	screencapArgv(adb: string, serial: string): string[] {
		return [adb, "-s", serial, "exec-out", "screencap", "-p"];
	}

	/** `getprop <key>` (boot flag, sdk level, model). */
	getpropArgv(key: string): string[] {
		return ["getprop", key];
	}

	/** Route 1: dump straight to the session's stdout. */
	dumpStdoutArgv(): string[] {
		return ["uiautomator", "dump", "/dev/stdout"];
	}

	/** Route 2 (host argv): `exec-out` gives uiautomator a tty-less stdout it accepts as `/dev/tty`. */
	dumpTtyHostArgv(adb: string, serial: string): string[] {
		return [adb, "-s", serial, "exec-out", "uiautomator", "dump", "/dev/tty"];
	}

	/**
	 * Route 3: dump to a file on the device then `cat` it (works on every image). The file is removed first so a
	 * failed dump can never hand back the previous screen; uiautomator's own message (`ERROR: null root node…`)
	 * is echoed when no file appears.
	 */
	dumpFileCommand(path: string = DUMP_FILE_PATH): string {
		const file = this.shellQuote(path);
		return `rm -f ${file}; OUT=$(uiautomator dump ${file} 2>&1); cat ${file} 2>/dev/null || echo "$OUT"`;
	}

	/** Host argv: `adb -s <serial> install -r <apk>`. */
	installArgv(adb: string, serial: string, apkPath: string): string[] {
		return [adb, "-s", serial, "install", "-r", apkPath];
	}

	/**
	 * Host argv: `adb -s <serial> emu geo fix <lon> <lat> [alt]`. The emulator console takes LONGITUDE first,
	 * the reverse of `simctl location set lat,lon` and of everything else here.
	 */
	geoFixArgv(adb: string, serial: string, point: LatLon, altM?: number): string[] {
		return [
			adb,
			"-s",
			serial,
			"emu",
			"geo",
			"fix",
			geoMath.formatCoord(point.lon),
			geoMath.formatCoord(point.lat),
			...(altM !== undefined ? [geoMath.formatCoord(altM)] : []),
		];
	}

	/** `adb emu` exits 0 even when the console answers `KO: …`; the reason, or undefined when it took. */
	geoFixFailure(res: { exitCode: number; stdout: string; stderr: string }): string | undefined {
		const text = `${res.stdout}\n${res.stderr}`;
		const ko = /^KO:?\s*(.*)$/m.exec(text);
		if (ko) return `emulator console: KO ${ko[1] ?? ""}`.trim();
		if (res.exitCode !== 0) return `adb emu geo fix exited ${res.exitCode}: ${text.trim().slice(0, 200)}`;
		return undefined;
	}

	uninstallArgv(adb: string, serial: string, packageName: string): string[] {
		return [adb, "-s", serial, "uninstall", packageName];
	}

	/** Exit 0 and `package:/…` when installed, exit 1 and nothing otherwise. */
	pmPathArgv(packageName: string): string[] {
		return ["pm", "path", packageName];
	}

	/** Exit 0 and the pids when running (API 24+). */
	pidofArgv(packageName: string): string[] {
		return ["pidof", packageName];
	}

	/** Lock auto-rotate off, then pin the rotation. */
	rotationArgvs(rotation: RotationValue): string[][] {
		return [
			["settings", "put", "system", "accelerometer_rotation", "0"],
			["settings", "put", "system", "user_rotation", String(rotation)],
		];
	}

	userRotationArgv(): string[] {
		return ["settings", "get", "system", "user_rotation"];
	}

	uimodeGetArgv(): string[] {
		return ["cmd", "uimode", "night"];
	}

	uimodeSetArgv(dark: boolean): string[] {
		return ["cmd", "uimode", "night", dark ? "yes" : "no"];
	}

	/** `input keycombination` (API 33+): modifiers first, the key last. */
	keycombinationArgv(keycodes: readonly number[]): string[] {
		return ["input", "keycombination", ...keycodes.map(String)];
	}

	/** Ctrl+A: select the whole text of the focused field (API 33+, see `SELECT_ALL_MIN_SDK`). */
	selectAllArgv(): string[] {
		return this.keycombinationArgv([this.modifierKeycode("ctrl"), KEYCODE_A]);
	}

	modifierKeycode(modifier: "shift" | "cmd" | "alt" | "ctrl"): number {
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
}

export const androidArgv = new AndroidArgv();
