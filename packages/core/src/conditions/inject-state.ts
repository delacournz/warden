import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ConditionArea, DEFAULT_KEYBOARD_MODE } from "./conditions.types";

/**
 * The state file an iOS app launched with `libwarden-inject.dylib` watches (offline flag, wall-clock offset /
 * freeze). The e2e driver owns the full format (`packages/e2e/src/driver/ios/inject.ts`); core only knows where it
 * lives and how to put it back to neutral on release, so a still-running injected app stops seeing the lease's
 * offline or shifted clock.
 */
export function injectStatePath(wardenHome: string, udid: string): string {
	return join(wardenHome, "inject", udid, "state.json");
}

/**
 * Write `{ seq: previous + 1, offline: false, clockOffsetMs: 0, camera: {} }` (no freeze, no camera feeds) when a state file exists; the dylib
 * applies any higher `seq`. `keyboard` stays what the file had, except when `area` is `keyboard`: then it goes back to the default. No file = no injected app was ever launched on the device: nothing to do.
 * Returns an error message, or undefined.
 */
export function neutralizeInjectState(path: string, area?: ConditionArea): string | undefined {
	if (!existsSync(path)) return undefined;
	let seq = 0;
	let keyboard: string | undefined;
	try {
		const data: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof data === "object" && data !== null && "seq" in data && typeof data.seq === "number") seq = data.seq;
		if (typeof data === "object" && data !== null && "keyboard" in data && typeof data.keyboard === "string") {
			keyboard = data.keyboard;
		}
	} catch {
		// unreadable: start over from 0, the dylib applies the next seq it has not seen
	}
	try {
		const tmp = `${path}.${process.pid}.tmp`;
		const mode = area === "keyboard" ? DEFAULT_KEYBOARD_MODE : keyboard;
		writeFileSync(
			tmp,
			JSON.stringify({
				seq: seq + 1,
				offline: false,
				clockOffsetMs: 0,
				camera: {},
				...(mode ? { keyboard: mode } : {}),
			})
		);
		renameSync(tmp, path);
		return undefined;
	} catch (error) {
		return `reset ${path}: ${error instanceof Error ? error.message : String(error)}`;
	}
}
