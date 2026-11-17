import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, createPrivateKey, createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PasskeyMode, PasskeyUv } from "@delacour/warden-core/conditions/conditions.types";
import {
	b64url,
	createPasskeyCredential,
	readPasskeyStore,
	writePasskeyStore,
} from "@delacour/warden-core/conditions/passkey-store";
import { createInjectChannel, type InjectChannel, injectLaunchEnv } from "../../src/driver/ios/inject";
import { INJECT_DYLIB, main } from "./inject";

/**
 * The virtual authenticator (`#pragma mark - passkeys` in WardenInject.m) against the real AuthenticationServices API:
 * the macOS harness builds ASAuthorizationController requests (`pk-run`), the dylib is inserted by dyld, and the
 * outputs are verified here with node's crypto (an independent WebAuthn check, not the dylib's own).
 */

let dir: string;
let built = false;
beforeAll(async () => {
	if (process.platform !== "darwin") return;
	dir = mkdtempSync(join(tmpdir(), "warden-inject-pk-build-"));
	built = (await main(["--macos", dir])) === 0;
}, 120_000);
afterAll(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

type Result = {
	event: "pk";
	kind: "auth" | "error" | "none" | "unsupported";
	calledSynchronously: boolean;
	calls: number;
	onMain?: boolean;
	isRegistration?: boolean;
	isAssertion?: boolean;
	providerIsPlatform?: boolean;
	attachment?: number;
	prfNil?: boolean;
	largeBlobNil?: boolean;
	credentialID?: string;
	rawClientDataJSON?: string;
	rawAttestationObject?: string;
	rawAuthenticatorData?: string;
	signature?: string;
	userID?: string;
	domain?: string;
	code?: number;
	userInfoCount?: number;
	reason?: string | null;
	description?: string;
};

type Run = {
	kind?: "reg" | "asr" | "none";
	rp: string;
	challenge?: string;
	name?: string;
	userId?: string;
	allow?: string[];
	exclude?: string[];
	extra?: ("password" | "securityKey")[];
	via?: "perform" | "options" | "autofill";
	options?: number;
	clientData?: boolean;
	cancel?: boolean;
	wait?: number;
};

type Rig = {
	channel: InjectChannel;
	storePath: string;
	set(mode?: PasskeyMode, uv?: PasskeyUv): Promise<void>;
	off(): Promise<void>;
	run(args: Run): Promise<Result>;
	stop(): Promise<void>;
};

/** A harness process with the dylib inserted and the authenticator on (`auto`, `match`) with an empty store. */
async function startRig(): Promise<Rig> {
	const root = mkdtempSync(join(tmpdir(), "warden-inject-pk-"));
	const channel = createInjectChannel({
		statePath: join(root, "state", "state.json"),
		now: Date.now,
		sleep: (ms) => Bun.sleep(ms),
	});
	const storePath = join(root, "passkeys", "U1", "store.json");
	const proc = Bun.spawn([join(dir, "harness")], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			...injectLaunchEnv({ dylib: join(dir, INJECT_DYLIB), statePath: channel.statePath, passkeys: true, debug: true }),
		},
	});
	const decoder = new TextDecoder();
	let buffer = "";
	const reader = proc.stdout.getReader();
	const nextLine = async (): Promise<string> => {
		for (;;) {
			const nl = buffer.indexOf("\n");
			if (nl >= 0) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				return line;
			}
			const chunk = await reader.read();
			if (chunk.done) throw new Error("harness exited");
			buffer += decoder.decode(chunk.value);
		}
	};
	const write = async (mode: PasskeyMode, uv: PasskeyUv) => {
		const state = channel.write({ passkeys: { mode, uv, storePath } });
		expect(await channel.acked(state.seq, 5_000)).toBe(true);
		expect(channel.attached()?.passkeys).toBe(true);
	};
	await write("auto", "match");
	return {
		channel,
		storePath,
		set: (mode = "auto", uv = "match") => write(mode, uv),
		async off() {
			const state = channel.write({});
			expect(await channel.acked(state.seq, 5_000)).toBe(true);
		},
		async run(args) {
			proc.stdin.write(`pk-run ${JSON.stringify(args)}\n`);
			return JSON.parse(await nextLine()) as Result;
		},
		async stop() {
			proc.stdin.write("quit\n");
			await proc.exited;
			rmSync(root, { recursive: true, force: true });
		},
	};
}

// ---- independent WebAuthn checks ----

const sha256 = (data: Buffer): Buffer => createHash("sha256").update(data).digest();
const bytes = (value: string | undefined): Buffer => Buffer.from(value ?? "", "base64url");

type Cbor = number | Buffer | string | Cbor[] | Map<Cbor, Cbor>;

function decodeCbor(buf: Buffer, start = 0): { value: Cbor; end: number } {
	const initial = buf[start] as number;
	const major = initial >> 5;
	const info = initial & 31;
	let at = start + 1;
	let n = info;
	if (info === 24) {
		n = buf[at] as number;
		at += 1;
	} else if (info === 25) {
		n = buf.readUInt16BE(at);
		at += 2;
	}
	if (major === 0) return { value: n, end: at };
	if (major === 1) return { value: -1 - n, end: at };
	if (major === 2) return { value: buf.subarray(at, at + n), end: at + n };
	if (major === 3) return { value: buf.subarray(at, at + n).toString("utf8"), end: at + n };
	if (major === 5) {
		const map = new Map<Cbor, Cbor>();
		for (let i = 0; i < n; i++) {
			const key = decodeCbor(buf, at);
			const value = decodeCbor(buf, key.end);
			map.set(key.value, value.value);
			at = value.end;
		}
		return { value: map, end: at };
	}
	throw new Error(`cbor major ${major} not handled`);
}

type Registered = {
	fmt: unknown;
	attStmt: unknown;
	flags: number;
	rpIdHash: Buffer;
	signCount: number;
	aaguid: Buffer;
	credentialId: Buffer;
	publicKey: ReturnType<typeof createPublicKey>;
	cose: Map<Cbor, Cbor>;
};

function parseRegistration(result: Result): Registered {
	const att = decodeCbor(bytes(result.rawAttestationObject)).value as Map<Cbor, Cbor>;
	const authData = att.get("authData") as Buffer;
	const idLength = authData.readUInt16BE(53);
	const credentialId = authData.subarray(55, 55 + idLength);
	const cose = decodeCbor(authData, 55 + idLength).value as Map<Cbor, Cbor>;
	const publicKey = createPublicKey({
		key: {
			kty: "EC",
			crv: "P-256",
			x: (cose.get(-2) as Buffer).toString("base64url"),
			y: (cose.get(-3) as Buffer).toString("base64url"),
		},
		format: "jwk",
	});
	return {
		fmt: att.get("fmt"),
		attStmt: att.get("attStmt"),
		flags: authData[32] as number,
		rpIdHash: authData.subarray(0, 32),
		signCount: authData.readUInt32BE(33),
		aaguid: authData.subarray(37, 53),
		credentialId,
		publicKey,
		cose,
	};
}

function assertionVerifies(result: Result, publicKey: ReturnType<typeof createPublicKey>): boolean {
	const signed = Buffer.concat([bytes(result.rawAuthenticatorData), sha256(bytes(result.rawClientDataJSON))]);
	return verify("sha256", signed, { key: publicKey, dsaEncoding: "der" }, bytes(result.signature));
}

const challenge = (): string => b64url(randomBytes(32));
const clientData = (result: Result): Record<string, unknown> =>
	JSON.parse(bytes(result.rawClientDataJSON).toString("utf8"));

const run = process.platform === "darwin" ? describe : describe.skip;

run("libwarden-inject passkeys (macOS build, real dyld insertion, real AuthenticationServices requests)", () => {
	test("register then assert: a verifiable none attestation, the real flags, the same credential id and user handle", async () => {
		expect(built).toBe(true);
		const rig = await startRig();
		const userId = b64url(randomBytes(16));
		const regChallenge = challenge();
		const reg = await rig.run({ kind: "reg", rp: "example.com", challenge: regChallenge, name: "ada", userId });
		expect(reg).toMatchObject({
			kind: "auth",
			isRegistration: true,
			providerIsPlatform: true,
			attachment: 0,
			prfNil: true,
			largeBlobNil: true,
		});
		expect(reg.calledSynchronously).toBe(false);
		expect(reg.onMain).toBe(true);
		const parsed = parseRegistration(reg);
		expect(parsed.fmt).toBe("none");
		expect(parsed.attStmt).toEqual(new Map());
		expect(parsed.flags).toBe(0x5d);
		expect(parsed.signCount).toBe(0);
		expect(parsed.rpIdHash).toEqual(sha256(Buffer.from("example.com")));
		expect(parsed.aaguid.toString("latin1")).toBe("warden-passkey\u0000\u0001");
		expect(parsed.credentialId.toString("base64url")).toBe(reg.credentialID as string);
		expect(parsed.cose.get(3)).toBe(-7);
		// {type, challenge, origin} with no crossOrigin: what iOS writes
		expect(clientData(reg)).toEqual({
			type: "webauthn.create",
			challenge: regChallenge,
			origin: "https://example.com",
		});

		const stored = readPasskeyStore(rig.storePath);
		expect(stored.success && stored.data).toHaveLength(1);
		const record = stored.success ? stored.data[0] : undefined;
		expect(record).toMatchObject({
			credentialId: reg.credentialID,
			rpId: "example.com",
			userHandle: userId,
			userName: "ada",
			signCount: 0,
			backupEligible: true,
			backupState: true,
		});
		expect(statSync(rig.storePath).mode & 0o777).toBe(0o600);

		const asrChallenge = challenge();
		const asr = await rig.run({ kind: "asr", rp: "example.com", challenge: asrChallenge });
		expect(asr).toMatchObject({
			kind: "auth",
			isAssertion: true,
			attachment: 0,
			prfNil: true,
			largeBlobNil: true,
			credentialID: reg.credentialID,
			userID: userId,
		});
		expect(clientData(asr)).toEqual({ type: "webauthn.get", challenge: asrChallenge, origin: "https://example.com" });
		const authData = bytes(asr.rawAuthenticatorData);
		expect(authData).toHaveLength(37);
		expect(authData[32]).toBe(0x1d);
		expect(authData.readUInt32BE(33)).toBe(0);
		expect(assertionVerifies(asr, parsed.publicKey)).toBe(true);
		await rig.stop();
	}, 60_000);

	test("a host-seeded credential (the PKCS#8 key warden generated) signs assertions that verify", async () => {
		const rig = await startRig();
		const credential = createPasskeyCredential(
			{ rpId: "seed.example.com", userName: "grace" },
			{ now: () => 1_700_000_000_000 }
		);
		if (!credential.success) throw new Error(credential.error);
		writePasskeyStore(rig.storePath, [credential.data]);
		const publicKey = createPublicKey(
			createPrivateKey({ key: Buffer.from(credential.data.privateKey, "base64url"), format: "der", type: "pkcs8" })
		);
		const asr = await rig.run({ kind: "asr", rp: "seed.example.com", challenge: challenge() });
		expect(asr).toMatchObject({
			kind: "auth",
			credentialID: credential.data.credentialId,
			userID: credential.data.userHandle,
		});
		expect(assertionVerifies(asr, publicKey)).toBe(true);
		await rig.stop();
	}, 60_000);

	test("a credential the dylib registered is a valid PKCS#8 key for node", async () => {
		const rig = await startRig();
		const reg = await rig.run({ kind: "reg", rp: "example.com", challenge: challenge() });
		const stored = readPasskeyStore(rig.storePath);
		const record = stored.success ? stored.data[0] : undefined;
		const fromStore = createPublicKey(
			createPrivateKey({ key: Buffer.from(record?.privateKey ?? "", "base64url"), format: "der", type: "pkcs8" })
		);
		expect(fromStore.export({ format: "jwk" })).toEqual(parseRegistration(reg).publicKey.export({ format: "jwk" }));
		await rig.stop();
	}, 60_000);

	test("allowCredentials picks the listed credential; without it the newest for the rp; none listed matches -> 1001", async () => {
		const rig = await startRig();
		const first = await rig.run({ kind: "reg", rp: "example.com", challenge: challenge() });
		await Bun.sleep(5);
		const second = await rig.run({ kind: "reg", rp: "example.com", challenge: challenge() });
		const other = await rig.run({ kind: "reg", rp: "other.example.com", challenge: challenge() });
		expect(new Set([first.credentialID, second.credentialID, other.credentialID]).size).toBe(3);

		const newest = await rig.run({ kind: "asr", rp: "example.com", challenge: challenge() });
		expect(newest.credentialID).toBe(second.credentialID);
		const listed = await rig.run({
			kind: "asr",
			rp: "example.com",
			challenge: challenge(),
			allow: [first.credentialID as string],
		});
		expect(listed.credentialID).toBe(first.credentialID);
		expect(assertionVerifies(listed, parseRegistration(first).publicKey)).toBe(true);
		const wrongRp = await rig.run({
			kind: "asr",
			rp: "example.com",
			challenge: challenge(),
			allow: [other.credentialID as string],
		});
		expect(wrongRp).toMatchObject({ kind: "error", code: 1001, userInfoCount: 0 });
		const unknown = await rig.run({
			kind: "asr",
			rp: "example.com",
			challenge: challenge(),
			allow: [b64url(randomBytes(16))],
		});
		expect(unknown).toMatchObject({
			kind: "error",
			domain: "com.apple.AuthenticationServices.AuthorizationError",
			code: 1001,
			userInfoCount: 0,
		});
		await rig.stop();
	}, 60_000);

	test("no credential with preferImmediatelyAvailableCredentials fails at once with the 'No credentials available for login.' reason", async () => {
		const rig = await startRig();
		const result = await rig.run({
			kind: "asr",
			rp: "example.com",
			challenge: challenge(),
			via: "options",
			options: 1,
		});
		expect(result).toMatchObject({ kind: "error", code: 1001, reason: "No credentials available for login." });
		expect(result.description).toContain("No credentials available for login.");
		const plain = await rig.run({ kind: "asr", rp: "example.com", challenge: challenge(), via: "options", options: 0 });
		expect(plain).toMatchObject({ kind: "error", code: 1001, userInfoCount: 0 });
		await rig.stop();
	}, 60_000);

	test("performRequestsWithOptions: answers an existing credential like performRequests", async () => {
		const rig = await startRig();
		const reg = await rig.run({ kind: "reg", rp: "example.com", challenge: challenge(), via: "options", options: 0 });
		expect(reg.kind).toBe("auth");
		const asr = await rig.run({ kind: "asr", rp: "example.com", challenge: challenge(), via: "options", options: 1 });
		expect(asr).toMatchObject({ kind: "auth", credentialID: reg.credentialID });
		await rig.stop();
	}, 60_000);

	test("excludeCredentials naming a stored credential -> 1006 and nothing is added", async () => {
		const rig = await startRig();
		const reg = await rig.run({ kind: "reg", rp: "example.com", challenge: challenge() });
		const again = await rig.run({
			kind: "reg",
			rp: "example.com",
			challenge: challenge(),
			exclude: [reg.credentialID as string],
		});
		expect(again).toMatchObject({ kind: "error", code: 1006, userInfoCount: 0 });
		const stored = readPasskeyStore(rig.storePath);
		expect(stored.success && stored.data).toHaveLength(1);
		const unrelated = await rig.run({
			kind: "reg",
			rp: "example.com",
			challenge: challenge(),
			exclude: [b64url(randomBytes(16))],
		});
		expect(unrelated.kind).toBe("auth");
		await rig.stop();
	}, 60_000);

	test("modes: cancel 1001, fail 1004, unavailable 1001 (a registration has no analogue: 1004); all with empty userInfo, async", async () => {
		const rig = await startRig();
		await rig.run({ kind: "reg", rp: "example.com", challenge: challenge() });
		await rig.set("cancel");
		const cancelled = await rig.run({ kind: "asr", rp: "example.com", challenge: challenge() });
		expect(cancelled).toMatchObject({
			kind: "error",
			code: 1001,
			userInfoCount: 0,
			calledSynchronously: false,
			onMain: true,
		});
		const cancelledReg = await rig.run({ kind: "reg", rp: "example.com", challenge: challenge() });
		expect(cancelledReg).toMatchObject({ kind: "error", code: 1001 });
		await rig.set("fail");
		expect(await rig.run({ kind: "asr", rp: "example.com", challenge: challenge() })).toMatchObject({
			kind: "error",
			code: 1004,
			userInfoCount: 0,
		});
		await rig.set("unavailable");
		expect(await rig.run({ kind: "asr", rp: "example.com", challenge: challenge() })).toMatchObject({
			kind: "error",
			code: 1001,
			userInfoCount: 0,
		});
		expect(
			await rig.run({ kind: "asr", rp: "example.com", challenge: challenge(), via: "options", options: 1 })
		).toMatchObject({ kind: "error", code: 1001, reason: "No credentials available for login." });
		expect(await rig.run({ kind: "reg", rp: "example.com", challenge: challenge() })).toMatchObject({
			kind: "error",
			code: 1004,
		});
		await rig.set("auto");
		expect((await rig.run({ kind: "asr", rp: "example.com", challenge: challenge() })).kind).toBe("auth");
		const stored = readPasskeyStore(rig.storePath);
		expect(stored.success && stored.data).toHaveLength(1);
		await rig.stop();
	}, 60_000);

	test("uv: nomatch -> 1001 (the user gave up on Face ID); skip clears the UV bit (0x59 / 0x19)", async () => {
		const rig = await startRig();
		await rig.set("auto", "nomatch");
		expect(await rig.run({ kind: "reg", rp: "example.com", challenge: challenge() })).toMatchObject({
			kind: "error",
			code: 1001,
			userInfoCount: 0,
		});
		await rig.set("auto", "skip");
		const reg = await rig.run({ kind: "reg", rp: "example.com", challenge: challenge() });
		expect(parseRegistration(reg).flags).toBe(0x59);
		const asr = await rig.run({ kind: "asr", rp: "example.com", challenge: challenge() });
		expect(bytes(asr.rawAuthenticatorData)[32]).toBe(0x19);
		expect(assertionVerifies(asr, parseRegistration(reg).publicKey)).toBe(true);
		await rig.set("auto", "match");
		const matched = await rig.run({ kind: "asr", rp: "example.com", challenge: challenge() });
		expect(bytes(matched.rawAuthenticatorData)[32]).toBe(0x1d);
		await rig.stop();
	}, 60_000);

	test("a platform request wins over a password and a security-key request in the same controller", async () => {
		const rig = await startRig();
		const reg = await rig.run({ kind: "reg", rp: "example.com", challenge: challenge(), extra: ["securityKey"] });
		expect(reg).toMatchObject({ kind: "auth", isRegistration: true });
		const asr = await rig.run({
			kind: "asr",
			rp: "example.com",
			challenge: challenge(),
			extra: ["password", "securityKey"],
		});
		expect(asr).toMatchObject({ kind: "auth", isAssertion: true, calls: 1 });
		await rig.stop();
	}, 60_000);

	test("a request built with clientData takes the challenge from it", async () => {
		const rig = await startRig();
		const value = challenge();
		const reg = await rig.run({ kind: "reg", rp: "example.com", challenge: value, clientData: true });
		expect(clientData(reg)).toEqual({ type: "webauthn.create", challenge: value, origin: "https://example.com" });
		await rig.stop();
	}, 60_000);

	test("-cancel before the async completion delivers 1001 instead of the credential", async () => {
		const rig = await startRig();
		const cancelled = await rig.run({ kind: "reg", rp: "example.com", challenge: challenge(), cancel: true });
		expect(cancelled).toMatchObject({ kind: "error", code: 1001, calls: 1 });
		const stored = readPasskeyStore(rig.storePath);
		expect(stored.success && stored.data.length).toBeLessThanOrEqual(1);
		await rig.stop();
	}, 60_000);

	test("an unreadable store fails the request (1004) instead of answering from nothing", async () => {
		const rig = await startRig();
		await Bun.write(rig.storePath, "{ not json");
		expect(await rig.run({ kind: "asr", rp: "example.com", challenge: challenge() })).toMatchObject({
			kind: "error",
			code: 1004,
		});
		await rig.stop();
	}, 60_000);

	test("a state without passkeys is applied and acked (the authenticator is off; the real OS answers again)", async () => {
		const rig = await startRig();
		await rig.off();
		expect(rig.channel.attached()?.passkeys).toBe(true);
		await rig.stop();
	}, 60_000);
});
