import { createHash } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import { type Store, storeLocator } from "@delacour/warden-store/store";

export type LiveLog = {
	path: string;
	write: (line: string) => void;
	/** unpublish (the file stays: a waiter drains it after the lock is free, the next build truncates it) */
	close: () => void;
};

export type LiveLogTail = {
	/** emit the complete lines written since the last poll, following the log published under the lock key */
	poll: () => void;
	/** emit what is left in the last log followed (the builder unpublishes it before the lock frees) */
	drain: () => void;
};

/** Store meta key holding the live log path of the build running under lock `lockKey`. */
const META_PREFIX = "buildlog:";

/** An open live log file, published under its lock keys until `close`. */
class LiveLogWriter implements LiveLog {
	private open = true;

	constructor(
		readonly path: string,
		private readonly fd: number,
		private readonly store: Store,
		private readonly lockKeys: string[]
	) {}

	readonly write = (line: string): void => {
		if (this.open) writeSync(this.fd, `${line}\n`);
	};

	readonly close = (): void => {
		if (!this.open) return;
		this.open = false;
		closeSync(this.fd);
		for (const key of this.lockKeys) {
			if (this.store.getMeta(`${META_PREFIX}${key}`) === this.path) this.store.deleteMeta(`${META_PREFIX}${key}`);
		}
	};
}

/** Follows the live log of whoever holds a lock key, handing each complete line to `onLine` once. */
class LiveLogFollower implements LiveLogTail {
	private path: string | undefined;
	private offset = 0;
	private pending = "";

	constructor(
		private readonly store: Store,
		private readonly lockKey: string,
		private readonly onLine: (line: string) => void
	) {}

	readonly poll = (): void => {
		const published = this.store.getMeta(`${META_PREFIX}${this.lockKey}`);
		if (published !== undefined && published !== this.path) {
			this.path = published;
			this.offset = 0;
			this.pending = "";
		}
		this.read();
	};

	readonly drain = (): void => this.read();

	private read(): void {
		if (this.path === undefined) return;
		let fd: number;
		try {
			fd = openSync(this.path, "r");
		} catch {
			return;
		}
		try {
			const size = fstatSync(fd).size;
			if (size < this.offset) {
				this.offset = 0;
				this.pending = "";
			}
			if (size === this.offset) return;
			const buf = Buffer.alloc(size - this.offset);
			const got = readSync(fd, buf, 0, buf.length, this.offset);
			this.offset += got;
			const lines = (this.pending + buf.subarray(0, got).toString("utf8")).split("\n");
			this.pending = lines.pop() ?? "";
			for (const line of lines) this.onLine(line);
		} finally {
			closeSync(fd);
		}
	}
}

/** The running local build's output as a file other wardens can tail, and the tail that follows it. */
export class LiveLogs {
	/**
	 * The running local build's output as a file other wardens can tail: published (store meta) under each lock key the
	 * build holds, so a process waiting on any of them shows the build as if it ran it. The first key names the file:
	 * pass the checkout's tree key first and there is one file per checkout + platform, truncated by each build.
	 */
	open(deps: { store: Store; env: Record<string, string | undefined> }, lockKeys: string[]): LiveLog {
		const dir = join(storeLocator.wardenHome(deps.env), "logs", "live");
		mkdirSync(dir, { recursive: true });
		const name = createHash("sha256")
			.update(lockKeys[0] ?? "")
			.digest("hex")
			.slice(0, 16);
		const path = join(dir, `build-${name}.log`);
		const fd = openSync(path, "w");
		for (const key of lockKeys) deps.store.setMeta(`${META_PREFIX}${key}`, path);
		return new LiveLogWriter(path, fd, deps.store, lockKeys);
	}

	/** Follow the live log of whoever holds `lockKey`, from its first line, handing each complete line to `onLine` once. */
	tail(store: Store, lockKey: string, onLine: (line: string) => void): LiveLogTail {
		return new LiveLogFollower(store, lockKey, onLine);
	}
}

export const liveLogs = new LiveLogs();
