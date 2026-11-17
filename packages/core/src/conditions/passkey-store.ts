import { createPrivateKey, generateKeyPairSync, type KeyObject, randomBytes as nodeRandomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { z } from "zod";
import type { PasskeyCredential } from "./conditions.types";

/**
 * The virtual authenticator's credentials for one device: `$WARDEN_HOME/passkeys/<device>/store.json`, a versioned
 * JSON file. On iOS the injected dylib reads and appends to it (atomic tmp + rename, like this module); on Android it
 * mirrors the provider app's own store. It belongs to the lease: release removes it (`undo.ts`). Private keys are test
 * keys, so the file is `0600` and never leaves the machine.
 */

export const PASSKEY_STORE_VERSION = 1;

export { passkeyStorePath, removePasskeyStore } from "./passkey-paths";

const B64URL = /^[A-Za-z0-9_-]+$/;
const b64urlField = z.string().regex(B64URL, "must be base64url");

const credentialSchema = z.object({
	credentialId: b64urlField,
	rpId: z.string().min(1),
	userHandle: b64urlField,
	userName: z.string(),
	displayName: z.string(),
	privateKey: b64urlField,
	signCount: z.number().int().nonnegative(),
	createdAt: z.number().int().nonnegative(),
	backupEligible: z.boolean(),
	backupState: z.boolean(),
}) satisfies z.ZodType<PasskeyCredential>;

const storeSchema = z.object({ version: z.literal(PASSKEY_STORE_VERSION), credentials: z.array(credentialSchema) });

export function b64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

/** Credentials in the store; a device with no store has none. A store that does not parse is an error, never `[]`. */
export function readPasskeyStore(path: string): Result<PasskeyCredential[]> {
	if (!existsSync(path)) return ok([]);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return err(`passkey store ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const parsed = storeSchema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		return err(`passkey store ${path}: ${issue ? `${issue.path.join(".")} ${issue.message}` : "invalid"}`);
	}
	return ok(parsed.data.credentials);
}

/** Replace the store's credentials (tmp + rename, `0600`), creating the device's directory. */
export function writePasskeyStore(path: string, credentials: readonly PasskeyCredential[]): Result<void> {
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify({ version: PASSKEY_STORE_VERSION, credentials }), { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, path);
		return ok(undefined);
	} catch (error) {
		return err(`write passkey store ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** What `warden ui passkey add` / `device.passkeys.add` take; everything but rp and user name is optional. */
export type PasskeyInput = {
	rpId: string;
	userName: string;
	displayName?: string;
	/** base64url; default 16 random bytes */
	userHandle?: string;
	/** base64url; default 16 random bytes */
	credentialId?: string;
	/** P-256 PKCS#8, PEM or base64url DER; default a fresh key */
	privateKey?: string;
	signCount?: number;
};

export type PasskeyDeps = { now: () => number; randomBytes?: (n: number) => Uint8Array };

/** A bare host name: lowercase labels, no scheme, port or path (what a WebAuthn rp id is). */
const RP_ID = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

function parseKey(text: string): Result<KeyObject> {
	try {
		const key = text.includes("-----BEGIN")
			? createPrivateKey({ key: text, format: "pem" })
			: createPrivateKey({ key: Buffer.from(text, "base64url"), format: "der", type: "pkcs8" });
		return ok(key);
	} catch (error) {
		return err(`privateKey is not a PKCS#8 key: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function p256Pkcs8(given: string | undefined): Result<string> {
	const key = given === undefined ? ok(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey) : parseKey(given);
	if (!key.success) return key;
	const curve = key.data.asymmetricKeyDetails?.namedCurve;
	if (key.data.asymmetricKeyType !== "ec" || curve !== "prime256v1") {
		return err(`privateKey must be a P-256 (ES256) PKCS#8 key, got ${curve ?? key.data.asymmetricKeyType}`);
	}
	return ok(key.data.export({ format: "der", type: "pkcs8" }).toString("base64url"));
}

function b64urlOr(given: string | undefined, name: string, random: (n: number) => Uint8Array): Result<string> {
	if (given === undefined) return ok(b64url(random(16)));
	return B64URL.test(given) ? ok(given) : err(`${name} must be base64url (A-Z a-z 0-9 - _), got ${given}`);
}

/** A new credential from `input`, validated: rp id, base64url ids and a P-256 key (generated when not given). */
export function createPasskeyCredential(input: PasskeyInput, deps: PasskeyDeps): Result<PasskeyCredential> {
	if (!RP_ID.test(input.rpId))
		return err(`rpId must be a bare lowercase host name like example.com, got "${input.rpId}"`);
	const random = deps.randomBytes ?? ((n: number) => new Uint8Array(nodeRandomBytes(n)));
	const credentialId = b64urlOr(input.credentialId, "credentialId", random);
	if (!credentialId.success) return credentialId;
	const userHandle = b64urlOr(input.userHandle, "userHandle", random);
	if (!userHandle.success) return userHandle;
	const privateKey = p256Pkcs8(input.privateKey);
	if (!privateKey.success) return privateKey;
	return ok({
		credentialId: credentialId.data,
		rpId: input.rpId,
		userHandle: userHandle.data,
		userName: input.userName,
		displayName: input.displayName ?? input.userName,
		privateKey: privateKey.data,
		signCount: input.signCount ?? 0,
		createdAt: deps.now(),
		backupEligible: true,
		backupState: true,
	});
}

/** `credentials` with `next` added, replacing one with the same credential id in place. */
export function upsertPasskey(credentials: readonly PasskeyCredential[], next: PasskeyCredential): PasskeyCredential[] {
	const at = credentials.findIndex((c) => c.credentialId === next.credentialId);
	if (at < 0) return [...credentials, next];
	return credentials.map((c, i) => (i === at ? next : c));
}

/** Credentials for `rpId` (all when undefined), newest first: the order an assertion without `allowCredentials` picks. */
export function filterPasskeys(
	credentials: readonly PasskeyCredential[],
	rpId: string | undefined
): PasskeyCredential[] {
	return credentials.filter((c) => rpId === undefined || c.rpId === rpId).sort((a, b) => b.createdAt - a.createdAt);
}

/** A credential as `list` reports it: without its private key unless `withKey` (`passkey list --with-keys`). */
export type PasskeyView = Omit<PasskeyCredential, "privateKey"> & { privateKey?: string };

export function publicPasskey(credential: PasskeyCredential, withKey: boolean): PasskeyView {
	if (withKey) return { ...credential };
	const { privateKey: _omit, ...rest } = credential;
	return rest;
}
