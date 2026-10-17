import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { lineStamper } from "./stamp-lines";

/**
 * A log file every line of which is stamped `[HH:MM:SS.mmm] ` as it is written. The stamp is the chunk's arrival
 * time in this process (every line of one chunk gets the same one), not the child's emission time: the child does not
 * stamp its own lines (measured at ~6 µs of parent CPU per chunk, not worth moving).
 */
export type StampedLog = {
	/** copy `stream` in until it ends, with its own line state (stdout and stderr each get one); never rejects */
	pump: (stream: ReadableStream<Uint8Array>) => Promise<void>;
	/**
	 * Resolves once every pump has ended (the moment the last one does), or no output has come for `quietMs`, or
	 * `maxMs` have passed, with how long it waited (ms; 0 when nothing was pumping). For after the process has exited:
	 * what its pipes still held is read within milliseconds, so a stream that stays silent is held open by a
	 * grandchild and waiting on it only delays the exit.
	 */
	drained: (window: { quietMs: number; maxMs: number }) => Promise<number>;
	/** close the file; later writes are dropped */
	close: () => void;
};

/** Open `path` for appending (creating its directory). */
export function openStampedLog(path: string, now: () => Date = () => new Date()): StampedLog {
	mkdirSync(dirname(path), { recursive: true });
	let fd: number | undefined = openSync(path, "a");
	const write = (text: string): void => {
		if (fd !== undefined && text !== "") writeSync(fd, text);
	};
	let pumping = 0;
	let lastChunkAt = performance.now();
	/** `drained` waiters, settled when the last pump ends */
	const idle = new Set<() => void>();
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
				if (pumping === 0) for (const settle of [...idle]) settle();
			}
		},
		drained({ quietMs, maxMs }) {
			const started = performance.now();
			if (pumping === 0) return Promise.resolve(0);
			return new Promise<number>((resolve) => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				const settle = () => {
					clearTimeout(timer);
					idle.delete(settle);
					resolve(performance.now() - started);
				};
				// one timer for whichever window ends first; output that came meanwhile pushes the quiet end out
				const check = () => {
					const at = performance.now();
					const quietLeft = quietMs - (at - Math.max(lastChunkAt, started));
					const maxLeft = maxMs - (at - started);
					if (quietLeft <= 0 || maxLeft <= 0) settle();
					else timer = setTimeout(check, Math.min(quietLeft, maxLeft));
				};
				idle.add(settle);
				check();
			});
		},
		close() {
			if (fd === undefined) return;
			closeSync(fd);
			fd = undefined;
		},
	};
}
