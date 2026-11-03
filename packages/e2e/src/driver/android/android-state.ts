import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { wardenHome } from "@delacour/warden-core/store";
import { z } from "zod";
import type { Logger } from "../driver.types";
import { ANIMATION_SETTINGS, type AnimationSetting, type AnimationValues } from "./android-argv";
import type { DumpRoute } from "./android-dump";

/**
 * What warden remembers about one Android device between processes (`$WARDEN_HOME/android/<serial>.json`):
 * - the API level it was learned on (a serial is reused by whatever image the emulator runs next, so the other
 *   fields are trusted only on the same level);
 * - the `uiautomator dump` route that worked (probing the wrong ones costs a whole dump each, ~2 s);
 * - the build of `warden-uiad` that could not run here (an API level it does not support), so later processes go
 *   straight to the dump instead of paying a failed start each time;
 * - the animation scales warden found before it turned them off, so a process that died without closing its
 *   driver does not leave the emulator animation-less for whatever runs next.
 *
 * Best effort throughout: a missing, unreadable or hand-edited file reads as empty and a failed write is logged,
 * never thrown. The file is read back into shell commands, so every field is validated down to a number-shaped value.
 */

export type AndroidDeviceState = {
	sdk?: number | undefined;
	dumpRoute?: DumpRoute | undefined;
	/** `uiadBuildId()` of a `warden-uiad` build that failed to start here for a reason that will not change */
	uiadUnsupported?: string | undefined;
	/** the scales to put back (what they were before warden set them to 0), while warden's zeros are in place */
	animations?: AnimationValues | undefined;
	/** physical phones: the rotation settings to put back, while warden's pinned rotation is in place */
	rotation?: RotationValues | undefined;
	/** physical phones: the `cmd uimode night` mode to put back, while warden's override is in place */
	uimode?: UimodeValue | undefined;
};

/** `settings get system` values as printed: a digit, or `null` when never set. */
export type RotationValues = { accelerometer_rotation: string; user_rotation: string };
export type UimodeValue = "yes" | "no" | "auto";

const scaleValue = z.string().regex(/^(null|\d+(\.\d+)?)$/);

const settingValue = z.string().regex(/^(null|\d)$/);

const stateSchema = z.strictObject({
	sdk: z.number().int().optional(),
	dumpRoute: z.enum(["stdout", "tty", "file"]).optional(),
	uiadUnsupported: z
		.string()
		.regex(/^[0-9a-f]{1,16}$/)
		.optional(),
	animations: z
		.strictObject({
			window_animation_scale: scaleValue,
			transition_animation_scale: scaleValue,
			animator_duration_scale: scaleValue,
		})
		.optional(),
	rotation: z.strictObject({ accelerometer_rotation: settingValue, user_rotation: settingValue }).optional(),
	uimode: z.enum(["yes", "no", "auto"]).optional(),
});

/** The slice of `node:fs/promises` the store uses (injected in tests). */
export type StateFs = {
	readFile(path: string): Promise<string>;
	writeFile(path: string, data: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	/** create the directory and its parents */
	mkdir(path: string): Promise<void>;
};

export const nodeStateFs: StateFs = {
	readFile: (path) => readFile(path, "utf8"),
	writeFile: (path, data) => writeFile(path, data),
	rename,
	mkdir: async (path) => {
		await mkdir(path, { recursive: true });
	},
};

export type AndroidStateStore = {
	/** the saved state of `serial`; `{}` when there is none or it cannot be read */
	read(serial: string): Promise<AndroidDeviceState>;
	/** replace the state with `change(what is on disk now)`; never rejects, and writes nothing when nothing changed */
	update(serial: string, change: (state: AndroidDeviceState) => AndroidDeviceState): Promise<void>;
};

/** `$WARDEN_HOME/android`. */
export function androidStateDir(home: string = wardenHome(process.env)): string {
	return join(home, "android");
}

/** `<dir>/<serial>.json`; anything in a serial that is not a plain file-name character becomes `_`. */
export function androidStateFile(dir: string, serial: string): string {
	return join(dir, `${serial.replace(/[^A-Za-z0-9._:-]/g, "_")}.json`);
}

export type AndroidStateStoreOptions = {
	dir: string;
	fs?: StateFs;
	log?: Logger;
};

export function createAndroidStateStore(options: AndroidStateStoreOptions): AndroidStateStore {
	const { dir, log } = options;
	const fs = options.fs ?? nodeStateFs;
	let queue: Promise<void> = Promise.resolve();

	async function load(serial: string): Promise<AndroidDeviceState> {
		let text: string;
		try {
			text = await fs.readFile(androidStateFile(dir, serial));
		} catch {
			return {};
		}
		try {
			const parsed = stateSchema.safeParse(JSON.parse(text));
			return parsed.success ? stripUndefined(parsed.data) : {};
		} catch {
			return {};
		}
	}

	async function save(serial: string, change: (state: AndroidDeviceState) => AndroidDeviceState): Promise<void> {
		const before = await load(serial);
		const after = stripUndefined(change(before));
		const text = JSON.stringify(after);
		if (text === JSON.stringify(before)) return;
		const file = androidStateFile(dir, serial);
		try {
			await fs.mkdir(dir);
			const temp = `${file}.${process.pid}.tmp`;
			await fs.writeFile(temp, text);
			await fs.rename(temp, file);
		} catch (error) {
			log?.(`could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return {
		read: load,
		update(serial, change) {
			const run = queue.then(() => save(serial, change));
			queue = run.catch(() => undefined);
			return run.catch(() => undefined);
		},
	};
}

/** A store that lives in memory (tests, and callers that want no file). */
export function memoryAndroidState(): AndroidStateStore {
	const states = new Map<string, AndroidDeviceState>();
	return {
		async read(serial) {
			return structuredClone(states.get(serial) ?? {});
		},
		async update(serial, change) {
			states.set(serial, stripUndefined(change(structuredClone(states.get(serial) ?? {}))));
		},
	};
}

/** `state` when it was learned on this API level (`undefined` = unknown matches unknown), else nothing is known. */
export function forSdk(state: AndroidDeviceState, sdk: number | undefined): AndroidDeviceState {
	return state.sdk === sdk ? state : {};
}

/** An `update` callback: keep what was learned on this API level, record the level, apply `patch` (`undefined` removes a field). */
export function patchFor(
	sdk: number | undefined,
	patch: Omit<AndroidDeviceState, "sdk">
): (state: AndroidDeviceState) => AndroidDeviceState {
	return (state) => ({ ...forSdk(state, sdk), ...(sdk !== undefined ? { sdk } : {}), ...patch });
}

function stripUndefined(state: AndroidDeviceState): AndroidDeviceState {
	return {
		...(state.sdk !== undefined ? { sdk: state.sdk } : {}),
		...(state.dumpRoute !== undefined ? { dumpRoute: state.dumpRoute } : {}),
		...(state.uiadUnsupported !== undefined ? { uiadUnsupported: state.uiadUnsupported } : {}),
		...(state.animations !== undefined ? { animations: state.animations } : {}),
		...(state.rotation !== undefined ? { rotation: state.rotation } : {}),
		...(state.uimode !== undefined ? { uimode: state.uimode } : {}),
	};
}

const SCALE_LINE = /^(null|\d+(\.\d+)?)$/;

/**
 * The three values `settings get global` printed, one per line in {@link ANIMATION_SETTINGS} order. Lines that are
 * not a value (an error message) are skipped; anything but exactly three values is unreadable (`undefined`).
 */
export function parseAnimationValues(stdout: string): AnimationValues | undefined {
	const lines = stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => SCALE_LINE.test(line));
	const [window, transition, animator] = lines;
	if (
		lines.length !== ANIMATION_SETTINGS.length ||
		window === undefined ||
		transition === undefined ||
		animator === undefined
	) {
		return undefined;
	}
	return { window_animation_scale: window, transition_animation_scale: transition, animator_duration_scale: animator };
}

/**
 * What to put back when the driver closes, given the scales as found now (just before warden turns them off) and
 * the originals a previous process saved and never restored (`pending`).
 *
 * A scale that reads `0` while `pending` has a value for it is warden's own leftover, so the saved value is the
 * original; any other value was set by someone else since, and is kept as it is. `undefined` when every original is
 * already `0` (animations were off before warden came: nothing to restore).
 */
export function planAnimations(
	current: AnimationValues,
	pending: AnimationValues | undefined
): AnimationValues | undefined {
	const original = (key: AnimationSetting): string => (current[key] === "0" && pending ? pending[key] : current[key]);
	const originals: AnimationValues = {
		window_animation_scale: original("window_animation_scale"),
		transition_animation_scale: original("transition_animation_scale"),
		animator_duration_scale: original("animator_duration_scale"),
	};
	return ANIMATION_SETTINGS.every((key) => originals[key] === "0") ? undefined : originals;
}
