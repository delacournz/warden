import { describe, expect, test } from "bun:test";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
	b64urlDecode,
	b64urlEncode,
	decodeCbor,
	parseAuthData,
	type Registration,
	verifyAssertion,
	verifyRegistration,
} from "./webauthn";

/** Minimal CBOR writer for fixtures: unsigned / negative ints, byte strings, text strings, maps. */
type CborIn = number | string | Uint8Array | Map<number | string, CborIn>;
function head(major: number, n: number): number[] {
	if (n < 24) return [(major << 5) | n];
	if (n < 0x100) return [(major << 5) | 24, n];
	return [(major << 5) | 25, n >> 8, n & 0xff];
}
function cbor(v: CborIn): number[] {
	if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
	if (typeof v === "string") {
		const b = [...new TextEncoder().encode(v)];
		return [...head(3, b.length), ...b];
	}
	if (v instanceof Uint8Array) return [...head(2, v.length), ...v];
	return [...head(5, v.size), ...[...v.entries()].flatMap(([k, x]) => [...cbor(k), ...cbor(x)])];
}

const RP_ID = "warden.co.nz";
const ORIGIN = "https://warden.co.nz";
const CHALLENGE = b64urlEncode(new Uint8Array(32).map((_, i) => i * 7));
const enc = (s: string) => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
};
const be32 = (n: number) => new Uint8Array([n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);

const UP = 0x01;
const UV = 0x04;
const BE = 0x08;
const BS = 0x10;
const AT = 0x40;

/** A software authenticator, the shape warden's virtual authenticator answers with. */
function authenticator(flags = UP | UV | BE | BS) {
	const secretKey = p256.utils.randomSecretKey();
	const publicKey = p256.getPublicKey(secretKey, false);
	const credId = new Uint8Array(16).map((_, i) => 200 - i);
	const cose = new Map<number, CborIn>([
		[1, 2],
		[3, -7],
		[-1, 1],
		[-2, publicKey.slice(1, 33)],
		[-3, publicKey.slice(33, 65)],
	]);
	const clientData = (type: string, challenge = CHALLENGE, origin = ORIGIN) =>
		enc(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
	const rpIdHash = sha256(enc(RP_ID));

	const register = (o: { challenge?: string; rpId?: string; type?: string } = {}) => {
		const authData = concat(
			sha256(enc(o.rpId ?? RP_ID)),
			new Uint8Array([flags | AT]),
			be32(0),
			new Uint8Array(16),
			new Uint8Array([0, credId.length]),
			credId,
			new Uint8Array(cbor(cose))
		);
		const attestationObject = new Uint8Array(
			cbor(
				new Map<string, CborIn>([
					["fmt", "none"],
					["attStmt", new Map()],
					["authData", authData],
				])
			)
		);
		return {
			id: b64urlEncode(credId),
			rawId: b64urlEncode(credId),
			response: {
				clientDataJSON: b64urlEncode(clientData(o.type ?? "webauthn.create", o.challenge)),
				attestationObject: b64urlEncode(attestationObject),
			},
		};
	};

	const assert = (o: { challenge?: string; tamper?: boolean; flags?: number; signCount?: number } = {}) => {
		const authData = concat(rpIdHash, new Uint8Array([o.flags ?? flags]), be32(o.signCount ?? 0));
		const cdj = clientData("webauthn.get", o.challenge);
		const signature = p256.sign(concat(authData, sha256(cdj)), secretKey, { format: "der" });
		if (o.tamper) signature[signature.length - 1] ^= 0xff;
		return {
			id: b64urlEncode(credId),
			response: {
				clientDataJSON: b64urlEncode(cdj),
				authenticatorData: b64urlEncode(authData),
				signature: b64urlEncode(signature),
			},
		};
	};

	return { register, assert, publicKey, credId };
}

describe("base64url", () => {
	test("round-trips bytes without padding", () => {
		const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
		const s = b64urlEncode(bytes);
		expect(s).not.toContain("=");
		expect(s).not.toMatch(/[+/]/);
		expect([...b64urlDecode(s)]).toEqual([...bytes]);
	});

	test("decodes standard base64 with padding too", () => {
		expect(new TextDecoder().decode(b64urlDecode("aGk+Pz8="))).toBe("hi>??");
	});
});

describe("decodeCbor", () => {
	test("reads maps of ints, negative ints, text and bytes", () => {
		const bytes = new Uint8Array(
			cbor(
				new Map<number | string, CborIn>([
					[1, 2],
					[-1, "a"],
					["k", new Uint8Array([9, 8])],
				])
			)
		);
		const value = decodeCbor(bytes);
		expect(value).toBeInstanceOf(Map);
		const map = value as Map<number | string, unknown>;
		expect(map.get(1)).toBe(2);
		expect(map.get(-1)).toBe("a");
		expect([...(map.get("k") as Uint8Array)]).toEqual([9, 8]);
	});
});

describe("parseAuthData", () => {
	test("reads flags, sign count and the attested credential", () => {
		const a = authenticator();
		const reg = a.register();
		const att = decodeCbor(b64urlDecode(reg.response.attestationObject)) as Map<string, unknown>;
		const parsed = parseAuthData(att.get("authData") as Uint8Array);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.flags).toEqual({ up: true, uv: true, be: true, bs: true, at: true });
		expect(parsed.value.signCount).toBe(0);
		expect(b64urlEncode(parsed.value.credential?.id ?? new Uint8Array())).toBe(reg.id);
		expect([...(parsed.value.credential?.publicKey ?? [])]).toEqual([...a.publicKey]);
	});

	test("too short is malformed", () => {
		expect(parseAuthData(new Uint8Array(10))).toEqual({ ok: false, reason: "malformed" });
	});
});

describe("verifyRegistration", () => {
	test("accepts a fresh passkey and returns what the readout shows", () => {
		const a = authenticator();
		const result = verifyRegistration(a.register(), { challenge: CHALLENGE, rpId: RP_ID });
		expect(result).toEqual({
			ok: true,
			value: {
				credentialId: b64urlEncode(a.credId),
				publicKey: b64urlEncode(a.publicKey),
				signCount: 0,
				userVerified: true,
				origin: ORIGIN,
			},
		});
	});

	test("rejects another challenge", () => {
		const a = authenticator();
		const other = b64urlEncode(new Uint8Array(32));
		expect(verifyRegistration(a.register({ challenge: other }), { challenge: CHALLENGE, rpId: RP_ID })).toEqual({
			ok: false,
			reason: "challenge",
		});
	});

	test("rejects another relying party", () => {
		const a = authenticator();
		expect(verifyRegistration(a.register({ rpId: "evil.example" }), { challenge: CHALLENGE, rpId: RP_ID })).toEqual({
			ok: false,
			reason: "rp",
		});
	});

	test("rejects a get response passed as a create", () => {
		const a = authenticator();
		expect(verifyRegistration(a.register({ type: "webauthn.get" }), { challenge: CHALLENGE, rpId: RP_ID })).toEqual({
			ok: false,
			reason: "type",
		});
	});

	test("rejects garbage instead of throwing", () => {
		const garbage = { id: "x", response: { clientDataJSON: "%%%", attestationObject: "AAAA" } };
		expect(verifyRegistration(garbage, { challenge: CHALLENGE, rpId: RP_ID })).toEqual({
			ok: false,
			reason: "malformed",
		});
	});
});

describe("verifyAssertion", () => {
	function registered(): { a: ReturnType<typeof authenticator>; stored: Registration } {
		const a = authenticator();
		const reg = verifyRegistration(a.register(), { challenge: CHALLENGE, rpId: RP_ID });
		if (!reg.ok) throw new Error("fixture registration failed");
		return { a, stored: reg.value };
	}

	test("accepts a signature from the registered key", () => {
		const { a, stored } = registered();
		expect(verifyAssertion(a.assert(), stored, { challenge: CHALLENGE, rpId: RP_ID })).toEqual({
			ok: true,
			value: { userVerified: true, signCount: 0, origin: ORIGIN },
		});
	});

	test("reports uv off when the authenticator skipped user verification", () => {
		const { a, stored } = registered();
		const result = verifyAssertion(a.assert({ flags: UP }), stored, { challenge: CHALLENGE, rpId: RP_ID });
		expect(result.ok && result.value.userVerified).toBe(false);
	});

	test("rejects a tampered signature", () => {
		const { a, stored } = registered();
		expect(verifyAssertion(a.assert({ tamper: true }), stored, { challenge: CHALLENGE, rpId: RP_ID })).toEqual({
			ok: false,
			reason: "signature",
		});
	});

	test("rejects a signature from another key", () => {
		const { stored } = registered();
		const other = authenticator();
		expect(verifyAssertion(other.assert(), stored, { challenge: CHALLENGE, rpId: RP_ID })).toEqual({
			ok: false,
			reason: "signature",
		});
	});

	test("rejects an unknown credential id", () => {
		const { a, stored } = registered();
		const response = { ...a.assert(), id: b64urlEncode(new Uint8Array([1, 2, 3])) };
		expect(verifyAssertion(response, stored, { challenge: CHALLENGE, rpId: RP_ID })).toEqual({
			ok: false,
			reason: "credential",
		});
	});

	test("rejects a missing user-presence flag", () => {
		const { a, stored } = registered();
		expect(verifyAssertion(a.assert({ flags: 0 }), stored, { challenge: CHALLENGE, rpId: RP_ID })).toEqual({
			ok: false,
			reason: "presence",
		});
	});

	test("rejects a replayed challenge", () => {
		const { a, stored } = registered();
		const fresh = b64urlEncode(new Uint8Array(32).fill(1));
		expect(verifyAssertion(a.assert(), stored, { challenge: fresh, rpId: RP_ID })).toEqual({
			ok: false,
			reason: "challenge",
		});
	});
});
