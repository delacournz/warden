import { createHash } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import { type Store, wardenHome } from "../store";

/** Store meta key holding the live log path of the build running under lock `lockKey`. */
function metaKey(lockKey: string): string {
	return `buildlog:${lockKey}`;
}

export type LiveLog = {
	path: string;
	write: (line: string) => void;
	/** unpublish (the file stays: a waiter drains it after the lock is free, the next build truncates it) */
	close: () => void;
};

/**
 * The running local build's output as a file other wardens can tail: published (store meta) under each lock key the
 * build holds, so a process waiting on any of them shows the build as if it ran it. The first key names the file:
 * pass the checkout's tree key first and there is one file per checkout + platform, truncated by each build.
 */
export function openLiveLog(
	deps: { store: Store; env: Record<string, string | undefined> },
	lockKeys: string[]
): LiveLog {
	const dir = join(wardenHome(deps.env), "logs", "live");
	mkdirSync(dir, { recursive: true });
	const name = createHash("sha256")
		.update(lockKeys[0] ?? "")
		.digest("hex")
		.slice(0, 16);
	const path = join(dir, `build-${name}.log`);
	const fd = openSync(path, "w");
	for (const key of lockKeys) deps.store.setMeta(metaKey(key), path);
	let open = true;
	return {
		path,
		write: (line) => {
			if (open) writeSync(fd, `${line}\n`);
		},
		close: () => {
			if (!open) return;
			open = false;
			closeSync(fd);
			for (const key of lockKeys) {
				if (deps.store.getMeta(metaKey(key)) === path) deps.store.deleteMeta(metaKey(key));
			}
		},
	};
}

export type LiveLogTail = {
	/** emit the complete lines written since the last poll, following the log published under the lock key */
	poll: () => void;
	/** emit what is left in the last log followed (the builder unpublishes it before the lock frees) */
	drain: () => void;
};

/** Follow the live log of whoever holds `lockKey`, from its first line, handing each complete line to `onLine` once. */
export function liveLogTail(store: Store, lockKey: string, onLine: (line: string) => void): LiveLogTail {
	let path: string | undefined;
	let offset = 0;
	let pending = "";
	const read = () => {
		if (path === undefined) return;
		let fd: number;
		try {
			fd = openSync(path, "r");
		} catch {
			return;
		}
		try {
			const size = fstatSync(fd).size;
			if (size < offset) {
				offset = 0;
				pending = "";
			}
			if (size === offset) return;
			const buf = Buffer.alloc(size - offset);
			const got = readSync(fd, buf, 0, buf.length, offset);
			offset += got;
			const lines = (pending + buf.subarray(0, got).toString("utf8")).split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) onLine(line);
		} finally {
			closeSync(fd);
		}
	};
	return {
		poll: () => {
			const published = store.getMeta(metaKey(lockKey));
			if (published !== undefined && published !== path) {
				path = published;
				offset = 0;
				pending = "";
			}
			read();
		},
		drain: read,
	};
}
