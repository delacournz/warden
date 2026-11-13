import { chmodSync, unlinkSync } from "node:fs";
import type { Socket } from "bun";
import { type AccessUnit, AuFlag, frameUnit } from "./au-framing";

export type AuSocketStats = { sent: number; bytes: number; dropped: number; connected: boolean };

export type AuSocket = {
	readonly path: string;
	/** queue one unit for the reader (dropped when none is connected) */
	send(unit: AccessUnit): void;
	/** try to write what is queued now (the drain callback also does) */
	flush(): void;
	stats(): AuSocketStats;
	close(): void;
};

export type AuSocketOptions = {
	path: string;
	/** a new reader, or a backlog that was cut: the next unit must be an IDR */
	onNeedKeyframe: () => void;
	/** units allowed to wait for the reader before the queue is cut (default 3, as on iOS) */
	maxQueued?: number;
	/** tests: hold writes back as a slow reader would */
	canWrite?: () => boolean;
};

/**
 * The Android side of the stream socket (`warden-simd` `AUSocket.swift` on iOS): one reader at a time, a newer
 * connection replaces the older, framed units (`au-framing.ts`) from a short queue. A reader that falls behind never
 * makes latency grow: the queue is emptied, units are dropped up to the next keyframe and one is asked for.
 */
export async function openAuSocket(options: AuSocketOptions): Promise<AuSocket> {
	const maxQueued = options.maxQueued ?? 3;
	const canWrite = options.canWrite ?? (() => true);
	try {
		unlinkSync(options.path);
	} catch {}
	let client: Socket<undefined> | undefined;
	let queue: Uint8Array[] = [];
	/** what is left of the unit being written (Bun writes can be partial) */
	let partial: Uint8Array | undefined;
	let waitKey = false;
	let closed = false;
	const counts = { sent: 0, bytes: 0, dropped: 0 };

	const flush = () => {
		while (client !== undefined && canWrite()) {
			const next = partial ?? queue.shift();
			if (next === undefined) return;
			const written = client.write(next);
			if (written < next.length) {
				partial = next.subarray(Math.max(0, written));
				return;
			}
			partial = undefined;
			counts.sent++;
			counts.bytes += next.length;
		}
	};

	const listener = Bun.listen<undefined>({
		unix: options.path,
		socket: {
			open(socket) {
				const previous = client;
				client = socket;
				queue = [];
				partial = undefined;
				waitKey = false;
				previous?.end();
				options.onNeedKeyframe();
			},
			data() {},
			drain: () => flush(),
			close(socket) {
				if (client === socket) {
					client = undefined;
					queue = [];
					partial = undefined;
				}
			},
			error(socket) {
				if (client === socket) client = undefined;
			},
		},
	});
	chmodSync(options.path, 0o600);

	return {
		path: options.path,
		send(unit) {
			if (client === undefined || closed) return;
			const key = (unit.flags & AuFlag.key) !== 0;
			if (waitKey && !key) {
				counts.dropped++;
				return;
			}
			waitKey = false;
			if (queue.length >= maxQueued) {
				counts.dropped += queue.length + 1;
				queue = [];
				if (!key) {
					waitKey = true;
					options.onNeedKeyframe();
					return;
				}
			}
			queue.push(frameUnit(unit));
			flush();
		},
		flush,
		stats: () => ({ ...counts, connected: client !== undefined }),
		close() {
			if (closed) return;
			closed = true;
			client?.end();
			client = undefined;
			listener.stop(true);
			try {
				unlinkSync(options.path);
			} catch {}
		},
	};
}
