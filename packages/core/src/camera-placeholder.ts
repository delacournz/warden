import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearCameraMode, readCameraMode } from "./camera-mode";

/** A 64x48 neutral grey PNG: what a camera emulator's cameras show until a feed is set. */
export const PLACEHOLDER_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAAAAACEICPDAAAALklEQVR4nGNooBAwjBowGgaj6WA0L4yWB6Nl4mi9MFo3jrYPRttIo+3EhmEaBgAwvgBbrECfuAAAAABJRU5ErkJggg==",
	"base64"
);

/**
 * Put a device's feeds back to the placeholders: both PNGs rewritten atomically (temp + rename, the emulator may be
 * reading), the staged videos and `mode.json` removed. The emulator itself keeps whatever source it launched with.
 */
export function resetCameraFeeds(dir: string): void {
	const mode = readCameraMode(dir);
	mkdirSync(dir, { recursive: true });
	for (const name of ["back.png", "front.png"]) {
		const tmp = join(dir, `.${name}.tmp-${process.pid}`);
		writeFileSync(tmp, PLACEHOLDER_PNG);
		renameSync(tmp, join(dir, name));
	}
	for (const video of Object.values(mode)) rmSync(join(dir, video), { force: true });
	clearCameraMode(dir);
}

/** Seed `back.png` and `front.png` in `dir` with the grey placeholder, leaving any existing file alone. */
export function seedCameraPlaceholders(dir: string): void {
	mkdirSync(dir, { recursive: true });
	for (const name of ["back.png", "front.png"]) {
		const path = join(dir, name);
		if (!existsSync(path)) writeFileSync(path, PLACEHOLDER_PNG);
	}
}
