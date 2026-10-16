import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** Reads a golden file; with `UPDATE_GOLDEN=1` (or when absent) writes `actual` there first. */
export function goldenText(path: string, actual: string): string {
	if (process.env.UPDATE_GOLDEN === "1" || !existsSync(path)) writeFileSync(path, actual);
	return readFileSync(path, "utf8");
}
