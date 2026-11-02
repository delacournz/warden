/** Console diagnostics for a WHEP session: why a connected-looking stream shows no picture. */

type StatsEntry = Record<string, unknown>;
type StatsLike = { forEach: (cb: (value: StatsEntry) => void) => void };

export type VideoCounters = { packetsReceived: number; framesDecoded: number; bytesReceived: number };
export type StatsSummary = { video: VideoCounters | null; pair: string | null };

const num = (value: unknown): number => (typeof value === "number" ? value : 0);

/** Inbound video counters and the nominated ICE pair's state from an `RTCStatsReport`. */
export function summarizeStats(report: StatsLike): StatsSummary {
	let video: VideoCounters | null = null;
	let pair: string | null = null;
	report.forEach((entry) => {
		if (entry.type === "inbound-rtp" && entry.kind === "video") {
			video = {
				packetsReceived: num(entry.packetsReceived),
				framesDecoded: num(entry.framesDecoded),
				bytesReceived: num(entry.bytesReceived),
			};
		} else if (entry.type === "candidate-pair" && entry.nominated === true && typeof entry.state === "string") {
			pair = entry.state;
		}
	});
	return { video, pair };
}

export function offerCandidateCount(sdp: string): number {
	return sdp.match(/^a=candidate:/gm)?.length ?? 0;
}

const STATS_EVERY_MS = 2000;
const STATS_SAMPLES = 5;

/**
 * Log ICE / connection state changes, and once connected a few stats samples, as `[whep]` lines in
 * the Web Inspector console. Returns a stop function.
 */
export function watchDiagnostics(conn: RTCPeerConnection): () => void {
	const log = (...args: unknown[]) => console.info("[whep]", ...args);
	let timer: ReturnType<typeof setInterval> | undefined;
	const onIce = () => log("ice", conn.iceConnectionState);
	const onConn = () => {
		log("connection", conn.connectionState);
		if (conn.connectionState !== "connected" || timer) return;
		let samples = 0;
		timer = setInterval(async () => {
			samples += 1;
			if (samples >= STATS_SAMPLES) clearInterval(timer);
			log("stats", summarizeStats(await conn.getStats()));
		}, STATS_EVERY_MS);
	};
	const onTrack = (event: RTCTrackEvent) => log("track", event.track.kind, event.track.readyState);
	conn.addEventListener("iceconnectionstatechange", onIce);
	conn.addEventListener("connectionstatechange", onConn);
	conn.addEventListener("track", onTrack);
	return () => {
		clearInterval(timer);
		conn.removeEventListener("iceconnectionstatechange", onIce);
		conn.removeEventListener("connectionstatechange", onConn);
		conn.removeEventListener("track", onTrack);
	};
}
