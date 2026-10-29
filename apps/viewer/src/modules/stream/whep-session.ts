import { whepCandidate, whepClose, whepOffer } from "../../core/api/device.api.ts";
import { backoffDelay, candidateFragment } from "./whep.ts";

export type StreamStatus = "connecting" | "streaming" | "reconnecting";

const DISCONNECT_GRACE_MS = 2000;

type SessionHooks = {
	onStatus: (status: StreamStatus) => void;
	onError: (message: string | null) => void;
};

/**
 * One WHEP receive session into `video`. Signalling goes through the Rust commands; the peer
 * connection is recvonly. A `failed` connection, or one that stays `disconnected` past a short grace,
 * is rebuilt with backoff. Returns `stop`, which tears everything down.
 */
export function startWhepSession(video: HTMLVideoElement, hooks: SessionHooks): () => void {
	let stopped = false;
	let attempt = 0;
	let pc: RTCPeerConnection | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let graceTimer: ReturnType<typeof setTimeout> | undefined;

	const teardown = async () => {
		clearTimeout(graceTimer);
		if (pc) {
			pc.onconnectionstatechange = null;
			pc.onicecandidate = null;
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

	const trickle = (conn: RTCPeerConnection) => {
		let answered = false;
		const queued: string[] = [];
		conn.onicecandidate = (event) => {
			const sdp = conn.localDescription?.sdp;
			if (!event.candidate || !sdp) return;
			const fragment = candidateFragment(event.candidate, sdp);
			if (!fragment) return;
			if (answered) whepCandidate(fragment).catch(() => undefined);
			else queued.push(fragment);
		};
		return () => {
			answered = true;
			for (const fragment of queued.splice(0)) whepCandidate(fragment).catch(() => undefined);
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
		const markAnswered = trickle(conn);
		watchConnection(conn);

		try {
			const offer = await conn.createOffer();
			await conn.setLocalDescription(offer);
			const answer = await whepOffer(conn.localDescription?.sdp ?? offer.sdp ?? "");
			if (stopped || pc !== conn) return;
			await conn.setRemoteDescription({ type: "answer", sdp: answer.sdp });
			markAnswered();
		} catch (e) {
			if (stopped) return;
			hooks.onError(e instanceof Error ? e.message : String(e));
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
