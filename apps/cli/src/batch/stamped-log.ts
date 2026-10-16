import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { lineStamper } from "./stamp-lines";

/** A log file every line of which is stamped `[HH:MM:SS.mmm] ` as it is written. */
export type StampedLog = {
	/** copy `stream` in until it ends, with its own line state (stdout and stderr each get one); never rejects */
	pump: (stream: ReadableStream<Uint8Array>) => Promise<void>;
	/**
	 * Resolves once every pump has ended, or no output has come for `quietMs`, or `maxMs` have passed.
	 * For after the process has exited: what its pipes still held is read within milliseconds, so a
	 * stream that stays silent is held open by a grandchild and waiting on it only delays the exit.
	 */
	drained: (window: { quietMs: number; maxMs: number }) => Promise<void>;
	/** close the file; later writes are dropped */
	close: () => void;
};

/** how often `drained` looks at the pumps */
const DRAIN_LOOK_MS = 10;

/** Open `path` for appending (creating its directory). */
export function openStampedLog(path: string, now: () => Date = () => new Date()): StampedLog {
	mkdirSync(dirname(path), { recursive: true });
	let fd: number | undefined = openSync(path, "a");
	const write = (text: string): void => {
		if (fd !== undefined && text !== "") writeSync(fd, text);
	};
	let pumping = 0;
	let lastChunkAt = performance.now();
	return {
		async pump(stream) {
			const stamp = lineStamper(now);
			const decoder = new TextDecoder();
			pumping++;
			try {
				for await (const bytes of stream) {
					lastChunkAt = performance.now();
					write(stamp(decoder.decode(bytes, { stream: true })));
				}
				write(stamp(decoder.decode()));
			} catch {
				// the stream broke or the file closed under it: what got through is in the log
			} finally {
				pumping--;
			}
		},
		async drained({ quietMs, maxMs }) {
			const started = performance.now();
			while (pumping > 0) {
				const at = performance.now();
				if (at - started >= maxMs || at - Math.max(lastChunkAt, started) >= quietMs) return;
				await Bun.sleep(DRAIN_LOOK_MS);
			}
		},
		close() {
			if (fd === undefined) return;
			closeSync(fd);
			fd = undefined;
		},
	};
}
