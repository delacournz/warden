import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { type BenchRun, parseBenchRun } from "./schema";

export const RESULTS_FILE = "bench-results.json";

/** JSON has no NaN / Infinity; stats of an empty sample (`n: 0`) become 0 so the file stays schema-valid. */
function finiteReplacer(_key: string, value: unknown): unknown {
	return typeof value === "number" && !Number.isFinite(value) ? 0 : value;
}

/** Writes via a temp file in the same directory and a rename, so a crash never leaves a half-written file. */
export function writeFileAtomic(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, path);
}

/** `<runDir>/bench-results.json`, atomically; called after every framework so a crash keeps what finished. */
export function writeBenchResults(runDir: string, run: BenchRun): string {
	const path = join(runDir, RESULTS_FILE);
	writeFileAtomic(path, `${JSON.stringify(run, finiteReplacer, 2)}\n`);
	return path;
}

/** Reads and validates `<runDir>/bench-results.json`. */
export function readBenchResults(runDir: string): Result<BenchRun> {
	let text: string;
	try {
		text = readFileSync(join(runDir, RESULTS_FILE), "utf8");
	} catch (e) {
		return err(`cannot read ${join(runDir, RESULTS_FILE)}: ${e instanceof Error ? e.message : String(e)}`);
	}
	const parsed = parseBenchRun(text);
	return parsed.success ? ok(parsed.data) : err(`${join(runDir, RESULTS_FILE)}: ${parsed.error}`);
}
