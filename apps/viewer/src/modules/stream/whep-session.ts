import { DeviceError, whepClose, whepOffer } from "../../core/api/device.api.ts";
import { backoffDelay, iceGatheringComplete } from "./whep.ts";
import { offerCandidateCount, watchDiagnostics } from "./whep-diagnostics.ts";

export type StreamStatus = "connecting" | "streaming" | "reconnecting" | "expired" | "stopped";
export type StreamError = { code: string; message: string };

const DISCONNECT_GRACE_MS = 2000;
const ICE_GATHER_TIMEOUT_MS = 2000;

function toStreamError(e: unknown): StreamError {
	if (e instanceof DeviceError) return { code: e.code, message: e.message };
	return { code: "UNKNOWN", message: e instanceof Error ? e.message : String(e) };
}

/**
 * Non-trickle WHEP offer/answer: wait for ICE gathering so the offer carries every candidate.
 * `stale` stops it once the session was stopped or replaced while a step was in flight.
 */
async function negotiate(conn: RTCPeerConnection, stale: () => boolean): Promise<void> {
	const offer = await conn.createOffer();
	await conn.setLocalDescription(offer);
	await iceGatheringComplete(conn, ICE_GATHER_TIMEOUT_MS);
	if (stale()) return;
	const sdp = conn.localDescription?.sdp ?? offer.sdp ?? "";
	console.info("[whep] offer", { candidates: offerCandidateCount(sdp) });
	const answer = await whepOffer(sdp);
	if (stale()) return;
	await conn.setRemoteDescription({ type: "answer", sdp: answer.sdp });
}

type SessionHooks = {
	onStatus: (status: StreamStatus) => void;
	onError: (error: StreamError | null) => void;
};

/**
 * One WHEP receive session into `video`. Signalling goes through the Rust commands; the peer
 * connection is recvonly and non-trickle: the offer waits for ICE gathering and carries every candidate. A `failed` connection, or one that stays `disconnected` past a short grace,
 * is rebuilt with backoff. Returns `stop`, which tears everything down.
 */
export function startWhepSession(video: HTMLVideoElement, hooks: SessionHooks): () => void {
	let stopped = false;
	let attempt = 0;
	let pc: RTCPeerConnection | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	let stopDiagnostics = () => {};

	const teardown = async () => {
		clearTimeout(graceTimer);
		stopDiagnostics();
		if (pc) {
			pc.onconnectionstatechange = null;
			pc.ontrack = null;
			pc.close();
			pc = null;
		}
		await whepClose().catch(() => undefined);
	};

	const scheduleRetry = () => {
		if (stopped) return;
		hooks.onStatus("reconnecting");
		const delay = backoffDelay(attempt);
		attempt += 1;
		void teardown().then(() => {
			if (!stopped) retryTimer = setTimeout(connect, delay);
		});
	};

	const watchConnection = (conn: RTCPeerConnection) => {
		conn.onconnectionstatechange = () => {
			if (stopped || pc !== conn) return;
			clearTimeout(graceTimer);
			const state = conn.connectionState;
			if (state === "connected") {
				attempt = 0;
				hooks.onError(null);
			} else if (state === "failed") {
				scheduleRetry();
			} else if (state === "disconnected") {
				graceTimer = setTimeout(() => {
					if (pc === conn && conn.connectionState === "disconnected") scheduleRetry();
				}, DISCONNECT_GRACE_MS);
			}
		};
	};

	const connect = async () => {
		if (stopped) return;
		const conn = new RTCPeerConnection();
		pc = conn;
		conn.addTransceiver("video", { direction: "recvonly" });
		conn.addTransceiver("audio", { direction: "recvonly" });
		conn.ontrack = (event) => {
			const stream = event.streams[0] ?? new MediaStream([event.track]);
			if (video.srcObject !== stream) video.srcObject = stream;
		};
		watchConnection(conn);
		stopDiagnostics = watchDiagnostics(conn);

		try {
			await negotiate(conn, () => stopped || pc !== conn);
		} catch (e) {
			if (stopped) return;
			const error = toStreamError(e);
			hooks.onError(error);
			if (error.code === "EXPIRED") {
				hooks.onStatus("expired");
				void teardown();
				return;
			}
			scheduleRetry();
		}
	};

	const onPlaying = () => hooks.onStatus("streaming");
	video.addEventListener("playing", onPlaying);
	void connect();

	return () => {
		stopped = true;
		clearTimeout(retryTimer);
		video.removeEventListener("playing", onPlaying);
		video.srcObject = null;
		void teardown();
	};
}
