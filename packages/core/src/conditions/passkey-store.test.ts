import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPrivateKey, createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PasskeyCredential } from "./conditions.types";
import {
	b64url,
	createPasskeyCredential,
	filterPasskeys,
	passkeyStorePath,
	publicPasskey,
	readPasskeyStore,
	removePasskeyStore,
	upsertPasskey,
	writePasskeyStore,
} from "./passkey-store";

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "warden-passkeys-"));
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

/** Deterministic randomness for ids: 0, 1, 2, … */
const counting = (n: number) => new Uint8Array(n).map((_, i) => i);
const deps = { now: () => 1_700_000_000_000, randomBytes: counting };

function credential(over: Partial<PasskeyCredential> = {}): PasskeyCredential {
	const made = createPasskeyCredential({ rpId: "warden.co.nz", userName: "demo@warden.co.nz" }, deps);
	if (!made.success) throw new Error(made.error);
	return { ...made.data, ...over };
}

describe("passkeyStorePath", () => {
	test("one store per device under WARDEN_HOME", () => {
		expect(passkeyStorePath("/h", "UDID-1")).toBe("/h/passkeys/UDID-1/store.json");
	});
});

describe("readPasskeyStore / writePasskeyStore", () => {
	test("a device without a store has no credentials", () => {
		expect(readPasskeyStore(passkeyStorePath(home, "x"))).toEqual({ success: true, data: [] });
	});

	test("round-trips credentials, creating the directory, readable by the owner only", () => {
		const path = passkeyStorePath(home, "x");
		const cred = credential();
		expect(writePasskeyStore(path, [cred])).toEqual({ success: true, data: undefined });
		expect(readPasskeyStore(path)).toEqual({ success: true, data: [cred] });
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
	});

	test("a corrupt store is an error, not an empty list", () => {
		const path = passkeyStorePath(home, "x");
		writePasskeyStore(path, []);
		writeFileSync(path, "{nope");
		const read = readPasskeyStore(path);
		expect(read.success).toBe(false);
	});

	test("a store with a malformed credential is an error naming the field", () => {
		const path = passkeyStorePath(home, "x");
		writePasskeyStore(path, []);
		writeFileSync(path, JSON.stringify({ version: 1, credentials: [{ credentialId: 1 }] }));
		const read = readPasskeyStore(path);
		expect(read.success).toBe(false);
		if (!read.success) expect(read.error).toContain("credentialId");
	});

	test("removePasskeyStore deletes the device's store and is fine when there is none", () => {
		const path = passkeyStorePath(home, "x");
		writePasskeyStore(path, [credential()]);
		expect(removePasskeyStore(path)).toBeUndefined();
		expect(existsSync(path)).toBe(false);
		expect(removePasskeyStore(path)).toBeUndefined();
	});
});

describe("createPasskeyCredential", () => {
	test("generates a P-256 key, a 16-byte id and a 16-byte user handle when not given", () => {
		const made = createPasskeyCredential({ rpId: "warden.co.nz", userName: "demo@warden.co.nz" }, deps);
		expect(made.success).toBe(true);
		if (!made.success) return;
		const c = made.data;
		expect(c.credentialId).toBe(b64url(counting(16)));
		expect(c.userHandle).toBe(b64url(counting(16)));
		expect(c.displayName).toBe("demo@warden.co.nz");
		expect(c).toMatchObject({ rpId: "warden.co.nz", signCount: 0, createdAt: 1_700_000_000_000 });
		expect(c).toMatchObject({ backupEligible: true, backupState: true });
		const key = createPrivateKey({ key: Buffer.from(c.privateKey, "base64url"), format: "der", type: "pkcs8" });
		expect(key.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
	});

	test("the generated key signs ES256 a verifier accepts", () => {
		const c = credential();
		const key = createPrivateKey({ key: Buffer.from(c.privateKey, "base64url"), format: "der", type: "pkcs8" });
		const sig = createSign("sha256").update("hello").sign(key);
		expect(createVerify("sha256").update("hello").verify(key, sig)).toBe(true);
	});

	test("keeps a given P-256 key, as PEM or base64url PKCS#8 DER, so a backend fixture can pre-register it", () => {
		const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
		const der = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
		const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
		for (const given of [der, pem]) {
			const made = createPasskeyCredential(
				{ rpId: "warden.co.nz", userName: "a", privateKey: given, credentialId: "AAEC", userHandle: "dXNlcg" },
				deps
			);
			expect(made.success && made.data.privateKey).toBe(der);
			expect(made.success && made.data.credentialId).toBe("AAEC");
			expect(made.success && made.data.userHandle).toBe("dXNlcg");
		}
	});

	test("refuses a key that is not P-256", () => {
		const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-384" });
		const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
		const made = createPasskeyCredential({ rpId: "warden.co.nz", userName: "a", privateKey: pem }, deps);
		expect(made).toEqual({ success: false, error: "privateKey must be a P-256 (ES256) PKCS#8 key, got secp384r1" });
	});

	test("refuses a key that does not parse", () => {
		const made = createPasskeyCredential({ rpId: "warden.co.nz", userName: "a", privateKey: "bm9wZQ" }, deps);
		expect(made.success).toBe(false);
		if (!made.success) expect(made.error).toStartWith("privateKey is not a PKCS#8 key");
	});

	test("refuses an rp id with a scheme, path or port", () => {
		for (const rpId of ["https://warden.co.nz", "warden.co.nz/x", "warden.co.nz:443", "", "WARDEN.co.nz"]) {
			const made = createPasskeyCredential({ rpId, userName: "a" }, deps);
			expect(made.success).toBe(false);
		}
	});

	test("refuses ids that are not base64url", () => {
		expect(createPasskeyCredential({ rpId: "a.b", userName: "a", credentialId: "a+b/" }, deps).success).toBe(false);
		expect(createPasskeyCredential({ rpId: "a.b", userName: "a", userHandle: "%%" }, deps).success).toBe(false);
	});
});

describe("upsertPasskey / filterPasskeys / publicPasskey", () => {
	test("adding an existing credential id replaces it", () => {
		const a = credential({ credentialId: "AAAA" });
		const b = credential({ credentialId: "BBBB" });
		const a2 = { ...a, signCount: 9 };
		expect(upsertPasskey(upsertPasskey([a, b], a2), b)).toEqual([a2, b]);
	});

	test("filters by rp id, newest first", () => {
		const old = credential({ credentialId: "AAAA", createdAt: 1 });
		const fresh = credential({ credentialId: "BBBB", createdAt: 2 });
		const other = credential({ credentialId: "CCCC", rpId: "other.example" });
		expect(filterPasskeys([old, fresh, other], "warden.co.nz").map((c) => c.credentialId)).toEqual(["BBBB", "AAAA"]);
		expect(filterPasskeys([old, other], undefined)).toHaveLength(2);
	});

	test("the public view drops the private key unless asked", () => {
		const c = credential();
		expect("privateKey" in publicPasskey(c, false)).toBe(false);
		expect(publicPasskey(c, true).privateKey).toBe(c.privateKey);
	});
});
