/** Pure helpers for the native stream: Rust sends `[kind u8][rtp timestamp u32 BE][body]`. */

export type NativeMessage =
	| { kind: "frame"; key: boolean; timestamp: number; data: Uint8Array }
	| { kind: "state"; state: string };

const KIND_DELTA = 0;
const KIND_KEY = 1;
const KIND_STATE = 2;
const HEADER = 5;

export function parseMessage(buffer: ArrayBuffer): NativeMessage | null {
	if (buffer.byteLength < HEADER) return null;
	const view = new DataView(buffer);
	const kind = view.getUint8(0);
	const timestamp = view.getUint32(1);
	const body = new Uint8Array(buffer, HEADER);
	if (kind === KIND_STATE) return { kind: "state", state: new TextDecoder().decode(body) };
	if (kind === KIND_KEY || kind === KIND_DELTA) {
		return { kind: "frame", key: kind === KIND_KEY, timestamp, data: new Uint8Array(body) };
	}
	return null;
}

const hex = (n: number | undefined) => (n ?? 0).toString(16).padStart(2, "0");

/** Where the NAL unit begins if a 3- or 4-byte start code sits at `i`, else -1. */
function nalStart(b: Uint8Array, i: number): number {
	if (b[i] !== 0 || b[i + 1] !== 0) return -1;
	if (b[i + 2] === 1) return i + 3;
	return b[i + 2] === 0 && b[i + 3] === 1 ? i + 4 : -1;
}

/** The WebCodecs codec string (`avc1.PPCCLL`) from the first SPS in an Annex-B access unit. */
export function avcCodec(annexb: Uint8Array): string | null {
	for (let i = 0; i + 3 < annexb.length; i++) {
		const start = nalStart(annexb, i);
		if (start < 0) continue;
		if (((annexb[start] ?? 0) & 0x1f) === 7 && start + 3 < annexb.length) {
			return `avc1.${hex(annexb[start + 1])}${hex(annexb[start + 2])}${hex(annexb[start + 3])}`;
		}
		i = start;
	}
	return null;
}

/** Microseconds since `first`, from 90 kHz RTP timestamps (wrap-safe). */
export function rtpToMicros(timestamp: number, first: number): number {
	const ticks = (timestamp - first) >>> 0;
	return Math.round((ticks * 1_000_000) / 90_000);
}
