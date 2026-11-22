import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * The relying-party checks the passkeys screen runs on what the platform authenticator returned, so it can show a
 * measured "signature valid" rather than trusting the OS call's success: challenge, type, rpIdHash, user presence and
 * the ES256 signature over `authenticatorData ‖ SHA-256(clientDataJSON)`. Origin is reported, not enforced: it is
 * `https://<rpId>` on iOS and `android:apk-key-hash:<…>` on Android, and the readout shows which one arrived.
 * Pure JS (no `crypto.subtle`, no `TextDecoder`), so it runs the same on Hermes and under `bun test`.
 */

/** Why a response was refused; the screen shows it in the `error` row. */
export type VerifyFailure =
	| "malformed"
	| "type"
	| "challenge"
	| "rp"
	| "presence"
	| "algorithm"
	| "credential"
	| "signature";

export type Verdict<T> = { ok: true; value: T } | { ok: false; reason: VerifyFailure };

/** What the screen keeps after a create, and shows in its readout. */
export type Registration = {
	credentialId: string;
	/** Uncompressed P-256 point (65 bytes), base64url. */
	publicKey: string;
	signCount: number;
	userVerified: boolean;
	origin: string;
};

export type Assertion = { userVerified: boolean; signCount: number; origin: string };

export type Expected = { challenge: string; rpId: string };

/** The fields of `react-native-passkey`'s create result this check reads. */
export type CreateResponse = { id: string; response: { clientDataJSON: string; attestationObject: string } };

/** The fields of `react-native-passkey`'s get result this check reads. */
export type GetResponse = {
	id: string;
	response: { clientDataJSON: string; authenticatorData: string; signature: string };
};

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function b64urlEncode(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i += 3) {
		const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
		const chars = i + 2 < bytes.length ? 4 : i + 1 < bytes.length ? 3 : 2;
		for (let c = 0; c < chars; c++) out += B64[(n >> (18 - 6 * c)) & 63];
	}
	return out;
}

/** Decodes base64url, and standard base64 (with `+` `/` `=`), since platforms disagree on which they send. */
export function b64urlDecode(text: string): Uint8Array {
	const clean = text.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
	const out: number[] = [];
	let buffer = 0;
	let bits = 0;
	for (const ch of clean) {
		const v = B64.indexOf(ch);
		if (v < 0) throw new Error(`not base64url: ${ch}`);
		buffer = (buffer << 6) | v;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out.push((buffer >> bits) & 0xff);
		}
	}
	return new Uint8Array(out);
}

function utf8(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; ) {
		const b = bytes[i++] ?? 0;
		let cp = b;
		if (b >= 0xf0)
			cp =
				((b & 7) << 18) | (((bytes[i++] ?? 0) & 63) << 12) | (((bytes[i++] ?? 0) & 63) << 6) | ((bytes[i++] ?? 0) & 63);
		else if (b >= 0xe0) cp = ((b & 15) << 12) | (((bytes[i++] ?? 0) & 63) << 6) | ((bytes[i++] ?? 0) & 63);
		else if (b >= 0xc0) cp = ((b & 31) << 6) | ((bytes[i++] ?? 0) & 63);
		out += String.fromCodePoint(cp);
	}
	return out;
}

export type CborValue =
	| number
	| string
	| boolean
	| null
	| Uint8Array
	| readonly CborValue[]
	| Map<CborValue, CborValue>;

/** Decodes the CBOR subset WebAuthn uses (ints, byte / text strings, arrays, maps, simple values). Throws on anything else. */
export function decodeCbor(bytes: Uint8Array): CborValue {
	let at = 0;
	const byte = () => {
		const b = bytes[at++];
		if (b === undefined) throw new Error("cbor: truncated");
		return b;
	};
	const length = (info: number): number => {
		if (info < 24) return info;
		if (info === 24) return byte();
		if (info === 25) return (byte() << 8) | byte();
		if (info === 26) return ((byte() << 24) >>> 0) + (byte() << 16) + (byte() << 8) + byte();
		throw new Error(`cbor: unsupported length ${info}`);
	};
	const take = (n: number) => {
		if (at + n > bytes.length) throw new Error("cbor: truncated");
		const out = bytes.slice(at, at + n);
		at += n;
		return out;
	};
	const item = (): CborValue => {
		const first = byte();
		const major = first >> 5;
		const info = first & 31;
		switch (major) {
			case 0:
				return length(info);
			case 1:
				return -1 - length(info);
			case 2:
				return take(length(info));
			case 3:
				return utf8(take(length(info)));
			case 4:
				return Array.from({ length: length(info) }, item);
			case 5: {
				const map = new Map<CborValue, CborValue>();
				for (let n = length(info); n > 0; n--) map.set(item(), item());
				return map;
			}
			case 7:
				if (info === 20) return false;
				if (info === 21) return true;
				if (info === 22) return null;
				throw new Error(`cbor: unsupported simple ${info}`);
			default:
				throw new Error(`cbor: unsupported major ${major}`);
		}
	};
	return item();
}

export type AuthData = {
	rpIdHash: Uint8Array;
	flags: { up: boolean; uv: boolean; be: boolean; bs: boolean; at: boolean };
	signCount: number;
	/** Present on a create (`AT` flag): the new credential's id and its ES256 key as an uncompressed point. */
	credential?: { id: Uint8Array; publicKey: Uint8Array };
};

/** ES256 on P-256, the only key type a platform passkey uses. */
const COSE_EC2 = 2;
const COSE_ES256 = -7;
const COSE_P256 = 1;

export function parseAuthData(bytes: Uint8Array): Verdict<AuthData> {
	if (bytes.length < 37) return { ok: false, reason: "malformed" };
	const flagByte = bytes[32] ?? 0;
	const flags = {
		up: (flagByte & 0x01) !== 0,
		uv: (flagByte & 0x04) !== 0,
		be: (flagByte & 0x08) !== 0,
		bs: (flagByte & 0x10) !== 0,
		at: (flagByte & 0x40) !== 0,
	};
	const signCount =
		(((bytes[33] ?? 0) << 24) >>> 0) + ((bytes[34] ?? 0) << 16) + ((bytes[35] ?? 0) << 8) + (bytes[36] ?? 0);
	const base = { rpIdHash: bytes.slice(0, 32), flags, signCount };
	if (!flags.at) return { ok: true, value: base };

	const idLength = ((bytes[53] ?? 0) << 8) | (bytes[54] ?? 0);
	const keyStart = 55 + idLength;
	if (bytes.length <= keyStart) return { ok: false, reason: "malformed" };
	const publicKey = es256PublicKey(bytes.slice(keyStart));
	if (!publicKey.ok) return publicKey;
	return { ok: true, value: { ...base, credential: { id: bytes.slice(55, keyStart), publicKey: publicKey.value } } };
}

/** The attested COSE key as an uncompressed P-256 point; anything but ES256 on P-256 is refused as `algorithm`. */
function es256PublicKey(coseBytes: Uint8Array): Verdict<Uint8Array> {
	let cose: CborValue;
	try {
		cose = decodeCbor(coseBytes);
	} catch {
		return { ok: false, reason: "malformed" };
	}
	if (!(cose instanceof Map)) return { ok: false, reason: "malformed" };
	if (cose.get(1) !== COSE_EC2 || cose.get(3) !== COSE_ES256 || cose.get(-1) !== COSE_P256) {
		return { ok: false, reason: "algorithm" };
	}
	const x = cose.get(-2);
	const y = cose.get(-3);
	if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) {
		return { ok: false, reason: "malformed" };
	}
	const point = new Uint8Array(65);
	point[0] = 0x04;
	point.set(x, 1);
	point.set(y, 33);
	return { ok: true, value: point };
}

type ClientData = { type: string; challenge: string; origin: string };

function clientDataOf(json: Uint8Array): ClientData | undefined {
	try {
		const parsed: unknown = JSON.parse(utf8(json));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const { type, challenge, origin } = parsed as Record<string, unknown>;
		return typeof type === "string" && typeof challenge === "string" && typeof origin === "string"
			? { type, challenge, origin }
			: undefined;
	} catch {
		return undefined;
	}
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** base64url values compare as bytes: one side may pad or use standard base64. */
function sameEncoded(a: string, b: string): boolean {
	try {
		return sameBytes(b64urlDecode(a), b64urlDecode(b));
	} catch {
		return false;
	}
}

function decodeAll(parts: readonly string[]): Uint8Array[] | undefined {
	try {
		return parts.map(b64urlDecode);
	} catch {
		return undefined;
	}
}

function checkClient(json: Uint8Array, type: string, expected: Expected): Verdict<ClientData> {
	const client = clientDataOf(json);
	if (!client) return { ok: false, reason: "malformed" };
	if (client.type !== type) return { ok: false, reason: "type" };
	if (!sameEncoded(client.challenge, expected.challenge)) return { ok: false, reason: "challenge" };
	return { ok: true, value: client };
}

function checkAuthData(authData: AuthData, rpId: string): VerifyFailure | undefined {
	if (!sameBytes(authData.rpIdHash, sha256(new TextEncoder().encode(rpId)))) return "rp";
	if (!authData.flags.up) return "presence";
	return undefined;
}

/** Checks a create response (attestation `none` is all the screen needs) and returns the credential to keep. */
export function verifyRegistration(result: CreateResponse, expected: Expected): Verdict<Registration> {
	const decoded = decodeAll([result.response.clientDataJSON, result.response.attestationObject]);
	if (!decoded) return { ok: false, reason: "malformed" };
	const [clientJson = new Uint8Array(), attestation = new Uint8Array()] = decoded;
	const client = checkClient(clientJson, "webauthn.create", expected);
	if (!client.ok) return client;

	let att: CborValue;
	try {
		att = decodeCbor(attestation);
	} catch {
		return { ok: false, reason: "malformed" };
	}
	const raw = att instanceof Map ? att.get("authData") : undefined;
	if (!(raw instanceof Uint8Array)) return { ok: false, reason: "malformed" };
	const parsed = parseAuthData(raw);
	if (!parsed.ok) return parsed;
	const failure = checkAuthData(parsed.value, expected.rpId);
	if (failure) return { ok: false, reason: failure };
	const credential = parsed.value.credential;
	if (!credential) return { ok: false, reason: "malformed" };

	return {
		ok: true,
		value: {
			credentialId: b64urlEncode(credential.id),
			publicKey: b64urlEncode(credential.publicKey),
			signCount: parsed.value.signCount,
			userVerified: parsed.value.flags.uv,
			origin: client.value.origin,
		},
	};
}

/** Checks a get response against the credential kept from `verifyRegistration`, signature included. */
export function verifyAssertion(result: GetResponse, stored: Registration, expected: Expected): Verdict<Assertion> {
	if (!sameEncoded(result.id, stored.credentialId)) return { ok: false, reason: "credential" };
	const decoded = decodeAll([
		result.response.clientDataJSON,
		result.response.authenticatorData,
		result.response.signature,
		stored.publicKey,
	]);
	if (!decoded) return { ok: false, reason: "malformed" };
	const [
		clientJson = new Uint8Array(),
		authBytes = new Uint8Array(),
		signature = new Uint8Array(),
		key = new Uint8Array(),
	] = decoded;
	const client = checkClient(clientJson, "webauthn.get", expected);
	if (!client.ok) return client;
	const parsed = parseAuthData(authBytes);
	if (!parsed.ok) return parsed;
	const failure = checkAuthData(parsed.value, expected.rpId);
	if (failure) return { ok: false, reason: failure };

	const signed = new Uint8Array(authBytes.length + 32);
	signed.set(authBytes);
	signed.set(sha256(clientJson), authBytes.length);
	let valid = false;
	try {
		valid = p256.verify(signature, signed, key, { format: "der", lowS: false });
	} catch {
		valid = false;
	}
	if (!valid) return { ok: false, reason: "signature" };
	return {
		ok: true,
		value: { userVerified: parsed.value.flags.uv, signCount: parsed.value.signCount, origin: client.value.origin },
	};
}
