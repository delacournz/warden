import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A 64x48 neutral grey PNG: what a camera emulator's cameras show until a feed is set. */
export const PLACEHOLDER_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAAAAACEICPDAAAALklEQVR4nGNooBAwjBowGgaj6WA0L4yWB6Nl4mi9MFo3jrYPRttIo+3EhmEaBgAwvgBbrECfuAAAAABJRU5ErkJggg==",
	"base64"
);

/** Seed `back.png` and `front.png` in `dir` with the grey placeholder, leaving any existing file alone. */
export function seedCameraPlaceholders(dir: string): void {
	mkdirSync(dir, { recursive: true });
	for (const name of ["back.png", "front.png"]) {
		const path = join(dir, name);
		if (!existsSync(path)) writeFileSync(path, PLACEHOLDER_PNG);
	}
}
