/**
 * The relay wire protocol (`warden host serve --uplink` ⇄ warden-api ⇄ `warden __relay-dial`). One WebSocket per
 * host uplink carries many channels; one WebSocket per laptop dial carries one. Each channel is exactly what one
 * ssh session to `__host-serve` would be: a command line, stdin, stdout, stderr, an exit code.
 *
 * - Text frames are control (`RelayControl`, JSON). `ch` is set on the uplink, absent on a dial (one channel).
 * - Binary frames are data: byte 0 the stream (`STREAM`), bytes 1–4 the channel (big-endian uint32, 0 on a dial),
 *   the rest the bytes.
 */

export const STREAM = { stdin: 0, stdout: 1, stderr: 2 } as const;
export type Stream = (typeof STREAM)[keyof typeof STREAM];

/** who the relay says the laptop is (from the user's API session, never from the laptop) */
export type RelayOwner = { machineId: string; user: string };

/** relay failures a dial can get instead of an exit code */
export type RelayErrorCode = "HOST_OFFLINE" | "HOST_EXPIRED" | "HOST_UNKNOWN" | "HOST_AUTH" | "RELAY";

export type RelayControl =
	/** dial: laptop → relay (no `ch`, no `owner`); uplink: relay → host, with both */
	| { t: "open"; ch?: number; cmd: string[]; owner?: RelayOwner }
	/** stdin closed */
	| { t: "eof"; ch?: number }
	/** the command ended (host → relay → laptop) */
	| { t: "exit"; ch?: number; code: number }
	/** relay → laptop: the channel could not run */
	| { t: "error"; code: RelayErrorCode; message: string };

const HEADER = 5;

export function encodeData(stream: Stream, ch: number, payload: Uint8Array): Uint8Array {
	const frame = new Uint8Array(HEADER + payload.length);
	frame[0] = stream;
	new DataView(frame.buffer).setUint32(1, ch);
	frame.set(payload, HEADER);
	return frame;
}

function isStream(n: number): n is Stream {
	return n === STREAM.stdin || n === STREAM.stdout || n === STREAM.stderr;
}

export function decodeData(frame: Uint8Array): { stream: Stream; ch: number; payload: Uint8Array } | undefined {
	if (frame.length < HEADER) return undefined;
	const stream = frame[0] ?? -1;
	if (!isStream(stream)) return undefined;
	const ch = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1);
	return { stream, ch, payload: frame.subarray(HEADER) };
}

const ERROR_CODES: readonly RelayErrorCode[] = ["HOST_OFFLINE", "HOST_EXPIRED", "HOST_UNKNOWN", "HOST_AUTH", "RELAY"];

function isErrorCode(code: unknown): code is RelayErrorCode {
	return ERROR_CODES.some((c) => c === code);
}

function field(o: object, key: string): unknown {
	return Reflect.get(o, key);
}

function channel(o: object): { ch?: number } | undefined {
	const ch = field(o, "ch");
	if (ch === undefined) return {};
	return typeof ch === "number" && Number.isInteger(ch) && ch >= 0 ? { ch } : undefined;
}

function owner(o: object): { owner?: RelayOwner } | undefined {
	const value = field(o, "owner");
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null) return undefined;
	const machineId = field(value, "machineId");
	const user = field(value, "user");
	return typeof machineId === "string" && typeof user === "string" ? { owner: { machineId, user } } : undefined;
}

function decodeOpen(o: object): RelayControl | undefined {
	const cmd = field(o, "cmd");
	if (!Array.isArray(cmd) || !cmd.every((w): w is string => typeof w === "string")) return undefined;
	const ch = channel(o);
	const who = owner(o);
	return ch && who ? { t: "open", ...ch, cmd, ...who } : undefined;
}

function decodeError(o: object): RelayControl | undefined {
	const code = field(o, "code");
	const message = field(o, "message");
	if (!isErrorCode(code) || typeof message !== "string") return undefined;
	return { t: "error", code, message };
}

/** A control frame, or undefined for anything malformed or unknown. */
export function decodeControl(text: string): RelayControl | undefined {
	let o: unknown;
	try {
		o = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof o !== "object" || o === null || Array.isArray(o)) return undefined;
	const t = field(o, "t");
	if (t === "open") return decodeOpen(o);
	if (t === "error") return decodeError(o);
	const ch = channel(o);
	if (ch === undefined) return undefined;
	if (t === "eof") return { t, ...ch };
	const code = field(o, "code");
	if (t === "exit" && typeof code === "number" && Number.isInteger(code)) return { t, ...ch, code };
	return undefined;
}
