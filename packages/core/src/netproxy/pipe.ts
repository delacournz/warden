import type { Socket } from "node:net";
import { sliceSize, TokenBucket } from "./shaping";

/** Bytes queued in a pipe before its source is paused (backpressure keeps shaping honest and memory flat). */
const HIGH_WATER = 64 * 1024;

type Queued = { data: Buffer; offset: number; notBefore: number };

export type PipeOptions = {
	/** bandwidth cap read per slice, so a live change applies to the next one */
	kbps: () => number | undefined;
	/** delay for the next chunk, read per chunk */
	delay: () => number;
	now: () => number;
	/** bytes written to `dest` */
	onBytes: (n: number) => void;
};

/**
 * One direction of a shaped connection. Chunks keep order; each waits out its own latency (pipelined,
 * not serial), then goes out in slices at the bandwidth cap. Driven by one timer at a time, never polled.
 */
export class Pipe {
	private queue: Queued[] = [];
	private queued = 0;
	private lastNotBefore = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private bucket = new TokenBucket();
	private finished = false;
	private stopped = false;
	private draining = false;

	constructor(
		private readonly src: Socket,
		private readonly dest: Socket,
		private readonly opts: PipeOptions
	) {}

	push(data: Buffer): void {
		if (this.stopped || data.length === 0) return;
		const notBefore = Math.max(this.lastNotBefore, this.opts.now() + this.opts.delay());
		this.lastNotBefore = notBefore;
		this.queue.push({ data, offset: 0, notBefore });
		this.queued += data.length;
		if (this.queued >= HIGH_WATER) this.src.pause();
		this.pump();
	}

	/** The source ended: close `dest` once everything queued is out. */
	finish(): void {
		this.finished = true;
		this.pump();
	}

	stop(): void {
		this.stopped = true;
		this.queue = [];
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	private wake(ms: number): void {
		this.timer = setTimeout(
			() => {
				this.timer = undefined;
				this.pump();
			},
			Math.max(1, Math.ceil(ms))
		);
	}

	/** What the head of the queue needs next: nothing, a wait (latency or bandwidth), or a send. */
	private next(): { kind: "idle" } | { kind: "wait"; ms: number } | { kind: "send"; head: Queued; size: number } {
		const head = this.queue[0];
		if (!head) return { kind: "idle" };
		const t = this.opts.now();
		if (head.notBefore > t) return { kind: "wait", ms: head.notBefore - t };
		const kbps = this.opts.kbps();
		const wait = kbps !== undefined && kbps > 0 ? this.bucket.waitMs(t) : 0;
		if (wait > 0) return { kind: "wait", ms: wait };
		return { kind: "send", head, size: Math.min(sliceSize(kbps), head.data.length - head.offset) };
	}

	private send(head: Queued, size: number): boolean {
		const slice = head.data.subarray(head.offset, head.offset + size);
		head.offset += size;
		if (head.offset >= head.data.length) this.queue.shift();
		this.queued -= size;
		this.bucket.take(size, this.opts.kbps(), this.opts.now());
		this.opts.onBytes(size);
		if (this.queued < HIGH_WATER / 2 && this.src.isPaused() && !this.finished) this.src.resume();
		if (this.dest.destroyed) {
			this.stop();
			return false;
		}
		if (this.dest.write(slice)) return true;
		this.draining = true;
		this.dest.once("drain", () => {
			this.draining = false;
			this.pump();
		});
		return false;
	}

	private pump(): void {
		while (!(this.stopped || this.timer || this.draining)) {
			const step = this.next();
			if (step.kind === "wait") {
				this.wake(step.ms);
				return;
			}
			if (step.kind === "idle") {
				if (this.finished && !this.dest.destroyed) this.dest.end();
				return;
			}
			if (!this.send(step.head, step.size)) return;
		}
	}
}
