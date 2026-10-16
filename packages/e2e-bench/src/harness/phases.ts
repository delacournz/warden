import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type TimedOptions = { now?: () => number };

/** Runs `fn` and returns its result with the elapsed milliseconds; the clock is injectable for tests. */
export async function timed<T>(
	_name: string,
	fn: () => Promise<T> | T,
	options: TimedOptions = {}
): Promise<{ result: T; ms: number }> {
	const now = options.now ?? (() => performance.now());
	const start = now();
	const result = await fn();
	return { result, ms: now() - start };
}

export type PhaseLog = { path: string; line(text: string): void; close(): void };

/**
 * Per-phase log at `<dir>/logs/<name>.log`. Appends synchronously so a crash mid-phase still leaves
 * every line written so far on disk.
 */
export function openPhaseLog(dir: string, name: string, clock: () => Date = () => new Date()): PhaseLog {
	const logDir = join(dir, "logs");
	mkdirSync(logDir, { recursive: true });
	const path = join(logDir, `${name}.log`);
	let closed = false;
	return {
		path,
		line(text) {
			if (closed) return;
			appendFileSync(path, `${clock().toISOString()} ${text}\n`);
		},
		close() {
			closed = true;
		},
	};
}
