import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { lineStamper } from "./stamp-lines";

/** A log file every line of which is stamped `[HH:MM:SS.mmm] ` as it is written. */
export type StampedLog = {
	/** copy `stream` in until it ends, with its own line state (stdout and stderr each get one); never rejects */
	pump: (stream: ReadableStream<Uint8Array>) => Promise<void>;
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
	return {
		async pump(stream) {
			const stamp = lineStamper(now);
			const decoder = new TextDecoder();
			try {
				for await (const bytes of stream) write(stamp(decoder.decode(bytes, { stream: true })));
				write(stamp(decoder.decode()));
			} catch {
				// the stream broke or the file closed under it: what got through is in the log
			}
		},
		close() {
			if (fd === undefined) return;
			closeSync(fd);
			fd = undefined;
		},
	};
}
