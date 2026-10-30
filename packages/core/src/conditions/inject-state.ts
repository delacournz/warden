import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
 * Write `{ seq: previous + 1, offline: false, clockOffsetMs: 0 }` (no freeze) when a state file exists; the dylib
 * applies any higher `seq`. No file = no injected app was ever launched on the device: nothing to do.
 * Returns an error message, or undefined.
 */
export function neutralizeInjectState(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	let seq = 0;
	try {
		const data: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof data === "object" && data !== null && "seq" in data && typeof data.seq === "number") seq = data.seq;
	} catch {
		// unreadable: start over from 0, the dylib applies the next seq it has not seen
	}
	try {
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify({ seq: seq + 1, offline: false, clockOffsetMs: 0 }));
		renameSync(tmp, path);
		return undefined;
	} catch (error) {
		return `reset ${path}: ${error instanceof Error ? error.message : String(error)}`;
	}
}
