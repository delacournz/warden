import { Channel } from "@tauri-apps/api/core";
import { DeviceError, nativeStreamStart, nativeStreamStop } from "../../core/api/device.api.ts";
import { avcCodec, parseMessage, rtpToMicros } from "./native-frames.ts";
import { backoffDelay } from "./whep.ts";
import type { StreamError, StreamStatus } from "./whep-session.ts";

type SessionHooks = {
	onStatus: (status: StreamStatus) => void;
	onError: (error: StreamError | null) => void;
	onSize: (size: { width: number; height: number }) => void;
};

const DISCONNECT_GRACE_MS = 2000;
/** Frames waiting in the decoder past this are dropped up to the next keyframe, to stay live. */
const MAX_DECODE_QUEUE = 8;

function toStreamError(e: unknown): StreamError {
	if (e instanceof DeviceError) return { code: e.code, message: e.message };
	return { code: "UNKNOWN", message: e instanceof Error ? e.message : String(e) };
}

const log = (...args: unknown[]) => console.info("[native]", ...args);

type Feeder = { push: (key: boolean, timestamp: number, data: Uint8Array) => void; close: () => void };

/**
 * A WebCodecs decoder fed whole access units. It starts at the first keyframe (its SPS gives the
 * codec string), and when decoding falls behind it drops delta frames up to the next keyframe so
 * the picture stays live rather than smooth.
 */
function createFeeder(output: (frame: VideoFrame) => void, onError: () => void): Feeder {
	let decoder: VideoDecoder | null = null;
	let first: number | null = null;
	let skipping = false;
	const open = (codec: string) => {
		log("decoder", codec);
		const created = new VideoDecoder({
			output,
			error: (e) => {
				log("decode error", e.message);
				onError();
			},
		});
		created.configure({ codec, optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" });
		return created;
	};
	return {
		push(key, timestamp, data) {
			if (!decoder && key) decoder = open(avcCodec(data) ?? "avc1.42e01f");
			if (decoder?.state !== "configured") return;
			if (decoder.decodeQueueSize > MAX_DECODE_QUEUE) skipping = true;
			if (skipping && !key) return;
			skipping = false;
			first ??= timestamp;
			const chunk = new EncodedVideoChunk({
				type: key ? "key" : "delta",
				timestamp: rtpToMicros(timestamp, first),
				data,
			});
			decoder.decode(chunk);
		},
		close() {
			if (decoder && decoder.state !== "closed") decoder.close();
			decoder = null;
		},
	};
}

/**
 * The native stream into `canvas`: Rust receives the WebRTC stream and sends whole H264 access
 * units over a Channel; WebCodecs decodes them. Used where WebKit's own receiver cannot assemble
 * the stream. A failed or long-disconnected connection is rebuilt with backoff. Returns `stop`.
 */
export function startNativeSession(canvas: HTMLCanvasElement, hooks: SessionHooks): () => void {
	let stopped = false;
	let attempt = 0;
	let generation = 0;
	let feeder: Feeder | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	const ctx = canvas.getContext("2d");

	const closeDecoder = () => {
		feeder?.close();
		feeder = null;
	};

	const scheduleRetry = () => {
		if (stopped) return;
		generation += 1;
		hooks.onStatus("reconnecting");
		closeDecoder();
		const delay = backoffDelay(attempt);
		attempt += 1;
		void nativeStreamStop()
			.catch(() => undefined)
			.then(() => {
				if (!stopped) retryTimer = setTimeout(connect, delay);
			});
	};

	const draw = (frame: VideoFrame) => {
		if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
			canvas.width = frame.displayWidth;
			canvas.height = frame.displayHeight;
			hooks.onSize({ width: frame.displayWidth, height: frame.displayHeight });
			log("first frame", frame.displayWidth, frame.displayHeight);
			hooks.onStatus("streaming");
		}
		ctx?.drawImage(frame, 0, 0);
		frame.close();
	};

	const connect = () => {
		if (stopped) return;
		const mine = ++generation;
		closeDecoder();
		const current = createFeeder(draw, () => {
			if (mine === generation) scheduleRetry();
		});
		feeder = current;
		const onState = (state: string) => {
			log("state", state);
			clearTimeout(graceTimer);
			if (state === "connected") {
				attempt = 0;
				hooks.onError(null);
			} else if (state === "failed" || state === "closed") {
				scheduleRetry();
			} else if (state === "disconnected") {
				graceTimer = setTimeout(() => {
					if (mine === generation) scheduleRetry();
				}, DISCONNECT_GRACE_MS);
			}
		};
		const channel = new Channel<ArrayBuffer>();
		channel.onmessage = (buffer) => {
			if (stopped || mine !== generation) return;
			const message = parseMessage(buffer);
			if (!message) return;
			if (message.kind === "state") onState(message.state);
			else current.push(message.key, message.timestamp, message.data);
		};
		nativeStreamStart(channel).catch((e: unknown) => {
			if (stopped || mine !== generation) return;
			const error = toStreamError(e);
			hooks.onError(error);
			if (error.code === "EXPIRED") {
				hooks.onStatus("expired");
				return;
			}
			scheduleRetry();
		});
	};

	connect();

	return () => {
		stopped = true;
		generation += 1;
		clearTimeout(retryTimer);
		clearTimeout(graceTimer);
		closeDecoder();
		void nativeStreamStop().catch(() => undefined);
	};
}
