import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Output is written at most this often. */
export const SESSION_LOG_FLUSH_MS = 250;
/** Held in memory per stream until the directory is known; more is dropped. */
export const MAX_PENDING_BYTES = 1024 * 1024;

export type SessionLogOptions = { now?: () => number };

export type SessionLog = {
	/** one entry per line of `text`: `<ISO time> [<task>] <line>` in `warden.log` */
	line(task: string, text: string): void;
	/** raw Metro PTY bytes, appended to `metro.log` as they came */
	metro(chunk: Uint8Array): void;
	/** the directory is known now (the device lease id exists): write what was held and carry on there */
	attach(dir: string): void;
	/** `<dir>/shots`, created on first ask; undefined until the directory is known */
	shotsDir(): string | undefined;
	/** flush and stop; idempotent */
	close(): void;
};

/**
 * Appends a dev session's output to `<dir>/warden.log` (text) and `<dir>/metro.log` (bytes). Writes are buffered
 * and flushed at most every 250 ms and on `close()`. Until `attach(dir)` gives the directory (the device lease id
 * is known at `ready()`), up to 1 MB per stream is held in memory. A disk failure drops the output; the log never
 * throws into the dashboard.
 */
export function openSessionLog(dir: string | undefined, options: SessionLogOptions = {}): SessionLog {
	const now = options.now ?? (() => Date.now());
	let target = dir;
	let text = "";
	let bytes: Uint8Array[] = [];
	let byteCount = 0;
	let droppedText = 0;
	let droppedBytes = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	let made = false;

	const ensureDir = (path: string): boolean => {
		if (made) return true;
		try {
			mkdirSync(path, { recursive: true });
			made = true;
		} catch {
			return false;
		}
		return true;
	};

	const flush = (): void => {
		timer = undefined;
		if (target === undefined) return;
		if (!ensureDir(target)) {
			text = "";
			bytes = [];
			byteCount = 0;
			return;
		}
		if (droppedBytes > 0) {
			text += `${new Date(now()).toISOString()} [session-log] dropped ${droppedBytes} bytes of Metro output before the session directory was known\n`;
			droppedBytes = 0;
		}
		if (droppedText > 0) {
			text += `${new Date(now()).toISOString()} [session-log] dropped ${droppedText} bytes of log text before the session directory was known\n`;
			droppedText = 0;
		}
		try {
			if (text !== "") appendFileSync(join(target, "warden.log"), text);
			if (byteCount > 0) appendFileSync(join(target, "metro.log"), Buffer.concat(bytes));
		} catch {
			// the log is best-effort
		}
		text = "";
		bytes = [];
		byteCount = 0;
	};

	const schedule = (): void => {
		if (timer !== undefined || target === undefined || closed) return;
		timer = setTimeout(flush, SESSION_LOG_FLUSH_MS);
		timer.unref?.();
	};

	return {
		line(task, body) {
			if (closed) return;
			const stamp = new Date(now()).toISOString();
			const entry = body
				.split("\n")
				.map((l) => `${stamp} [${task}] ${l}\n`)
				.join("");
			if (target === undefined && text.length + entry.length > MAX_PENDING_BYTES) {
				droppedText += entry.length;
				return;
			}
			text += entry;
			schedule();
		},
		metro(chunk) {
			if (closed) return;
			if (target === undefined && byteCount + chunk.length > MAX_PENDING_BYTES) {
				droppedBytes += chunk.length;
				return;
			}
			bytes.push(chunk);
			byteCount += chunk.length;
			schedule();
		},
		attach(next) {
			if (closed || target !== undefined) return;
			target = next;
			schedule();
		},
		shotsDir() {
			if (target === undefined) return undefined;
			const shots = join(target, "shots");
			try {
				mkdirSync(shots, { recursive: true });
			} catch {
				return undefined;
			}
			return shots;
		},
		close() {
			if (closed) return;
			if (timer !== undefined) clearTimeout(timer);
			flush();
			closed = true;
		},
	};
}
