import { Channel } from "@tauri-apps/api/core";
import { DeviceError, localStreamAnswer, nativeStreamStart, nativeStreamStop } from "../../core/api/device.api.ts";
import { backoffDelay, iceGatheringComplete } from "./whep.ts";
import { watchDiagnostics } from "./whep-diagnostics.ts";
import type { SessionHooks, StreamError } from "./whep-session.ts";

const DISCONNECT_GRACE_MS = 2000;
const ICE_GATHER_TIMEOUT_MS = 1000;

function toStreamError(e: unknown): StreamError {
	if (e instanceof DeviceError) return { code: e.code, message: e.message };
	return { code: "UNKNOWN", message: e instanceof Error ? e.message : String(e) };
}

const log = (...args: unknown[]) => console.info("[native]", ...args);

/** The loopback leg is lossless and in-process: play each frame as soon as it decodes. */
function playImmediately(receiver: RTCRtpReceiver) {
	const tunable = receiver as RTCRtpReceiver & { jitterBufferTarget?: number | null; playoutDelayHint?: number };
	if ("jitterBufferTarget" in tunable) tunable.jitterBufferTarget = 0;
	if ("playoutDelayHint" in tunable) tunable.playoutDelayHint = 0;
}

/**
 * The native stream into `video`. Rust receives Revyl's WebRTC stream (WebKit's own receiver
 * cannot assemble it), rebuilds spec-compliant H264 and re-publishes it on a loopback peer
 * connection that this webview receives like any WebRTC stream. Upstream connection state comes
 * on a Channel. Either leg failing, or the upstream one staying disconnected, rebuilds both with
 * backoff. Returns `stop`.
 */
export function startNativeSession(video: HTMLVideoElement, hooks: SessionHooks): () => void {
	let stopped = false;
	let attempt = 0;
	let generation = 0;
	let pc: RTCPeerConnection | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	let stopDiagnostics = () => {};

	const closeLocal = () => {
		stopDiagnostics();
		if (pc) {
			pc.onconnectionstatechange = null;
			pc.ontrack = null;
			pc.close();
			pc = null;
		}
	};

	const scheduleRetry = () => {
		if (stopped) return;
		generation += 1;
		clearTimeout(graceTimer);
		hooks.onStatus("reconnecting");
		closeLocal();
		const delay = backoffDelay(attempt);
		attempt += 1;
		void nativeStreamStop()
			.catch(() => undefined)
			.then(() => {
				if (!stopped) retryTimer = setTimeout(connect, delay);
			});
	};

	const fail = (mine: number) => (e: unknown) => {
		if (stopped || mine !== generation) return;
		const error = toStreamError(e);
		hooks.onError(error);
		if (error.code === "EXPIRED") {
			hooks.onStatus("expired");
			return;
		}
		scheduleRetry();
	};

	const startUpstream = (mine: number) => {
		const channel = new Channel<string>();
		channel.onmessage = (state) => {
			if (stopped || mine !== generation) return;
			log("upstream", state);
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
		nativeStreamStart(channel).catch(fail(mine));
	};

	const startLocal = async (mine: number) => {
		const conn = new RTCPeerConnection({ iceServers: [] });
		pc = conn;
		const { receiver } = conn.addTransceiver("video", { direction: "recvonly" });
		playImmediately(receiver);
		conn.ontrack = (event) => {
			const stream = event.streams[0] ?? new MediaStream([event.track]);
			if (video.srcObject !== stream) video.srcObject = stream;
		};
		conn.onconnectionstatechange = () => {
			if (stopped || mine !== generation) return;
			log("local", conn.connectionState);
			if (conn.connectionState === "failed") scheduleRetry();
		};
		stopDiagnostics = watchDiagnostics(conn);
		const offer = await conn.createOffer();
		await conn.setLocalDescription(offer);
		await iceGatheringComplete(conn, ICE_GATHER_TIMEOUT_MS);
		if (stopped || mine !== generation) return;
		const answer = await localStreamAnswer(conn.localDescription?.sdp ?? offer.sdp ?? "");
		if (stopped || mine !== generation) return;
		await conn.setRemoteDescription({ type: "answer", sdp: answer.sdp });
	};

	const connect = () => {
		if (stopped) return;
		const mine = ++generation;
		closeLocal();
		startUpstream(mine);
		startLocal(mine).catch(fail(mine));
	};

	const onPlaying = () => hooks.onStatus("streaming");
	video.addEventListener("playing", onPlaying);
	connect();

	return () => {
		stopped = true;
		generation += 1;
		clearTimeout(retryTimer);
		clearTimeout(graceTimer);
		video.removeEventListener("playing", onPlaying);
		video.srcObject = null;
		closeLocal();
		void nativeStreamStop().catch(() => undefined);
	};
}
