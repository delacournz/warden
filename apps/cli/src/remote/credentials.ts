import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wardenHome } from "@delacour/warden-core/store";
import { err, ok, type Result } from "@delacour/warden-types/result";

type Env = Record<string, string | undefined>;

/** Where warden-api lives unless `WARDEN_API_URL` says otherwise. */
export const DEFAULT_API_URL = "https://api.warden.co.nz";

/** What `warden login` saves: the session token for one warden-api, plus who it belongs to. */
export type Credentials = {
	apiUrl: string;
	token: string;
	user: { id: string; email: string };
	/** the org remote devices are billed to (better-auth's active organization) */
	organizationId?: string;
	savedAt: number;
};

export function credentialsPath(env: Env): string {
	return join(wardenHome(env), "auth.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCredentials(value: unknown): Credentials | undefined {
	if (!isRecord(value)) return undefined;
	const { apiUrl, token, user, organizationId, savedAt } = value;
	if (typeof apiUrl !== "string" || typeof token !== "string" || typeof savedAt !== "number") return undefined;
	if (!isRecord(user) || typeof user.id !== "string" || typeof user.email !== "string") return undefined;
	if (organizationId !== undefined && typeof organizationId !== "string") return undefined;
	return {
		apiUrl,
		token,
		user: { id: user.id, email: user.email },
		...(organizationId !== undefined ? { organizationId } : {}),
		savedAt,
	};
}

/** Name of the account a v1 file (or the first login) is saved under. */
export const DEFAULT_ACCOUNT = "default";

/** Account names: lowercase letters, digits and dashes, 1-32 chars, not starting with a dash. */
export const ACCOUNT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isAccountName(name: string): boolean {
	return ACCOUNT_NAME.test(name);
}

/** `auth.json` v2: every saved login by name, plus the one commands use unless told otherwise. */
export type Accounts = {
	version: 2;
	default: string;
	accounts: Record<string, Credentials>;
};

function parseAccounts(value: unknown): Accounts | undefined {
	if (!isRecord(value)) return undefined;
	if (value.version === undefined) {
		const legacy = parseCredentials(value);
		return legacy ? { version: 2, default: DEFAULT_ACCOUNT, accounts: { [DEFAULT_ACCOUNT]: legacy } } : undefined;
	}
	if (value.version !== 2 || typeof value.default !== "string" || !isRecord(value.accounts)) return undefined;
	const accounts: Record<string, Credentials> = {};
	for (const [name, raw] of Object.entries(value.accounts)) {
		const creds = parseCredentials(raw);
		if (!isAccountName(name) || !creds) return undefined;
		accounts[name] = creds;
	}
	if (!(value.default in accounts)) return undefined;
	return { version: 2, default: value.default, accounts };
}

/** Every saved login, `undefined` when there is no file; a damaged file is an error (re-run `warden login`). v1 files are migrated in memory. */
export function readAccounts(env: Env): Result<Accounts | undefined> {
	const path = credentialsPath(env);
	if (!existsSync(path)) return ok(undefined);
	try {
		const parsed = parseAccounts(JSON.parse(readFileSync(path, "utf8")));
		return parsed ? ok(parsed) : err(`${path} is not a warden login; run warden login again`);
	} catch (e) {
		return err(`${path}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** Save atomically (temp file + rename), readable by the owner only. */
function writeAccounts(env: Env, accounts: Accounts): Result<Accounts> {
	const path = credentialsPath(env);
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		mkdirSync(wardenHome(env), { recursive: true });
		writeFileSync(tmp, `${JSON.stringify(accounts, null, 2)}\n`, { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, path);
		return ok(accounts);
	} catch (e) {
		rmSync(tmp, { force: true });
		return err(`could not save ${path}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** Add or overwrite one account; the first one (or one when the default is gone) becomes the default. */
export function writeAccount(env: Env, name: string, credentials: Credentials): Result<Accounts> {
	if (!isAccountName(name)) return err(`invalid account name "${name}" (lowercase letters, digits, dashes; max 32)`);
	const current = readAccounts(env);
	if (!current.success) return current;
	const existing = current.data;
	const accounts = { ...existing?.accounts, [name]: credentials };
	const keepDefault = existing !== undefined && existing.default in accounts;
	return writeAccounts(env, { version: 2, default: keepDefault ? existing.default : name, accounts });
}

/** Remove one account; removing the default promotes the alphabetically first left, removing the last deletes the file. */
export function removeAccount(env: Env, name: string): Result<{ removed: boolean; accounts: Accounts | undefined }> {
	const current = readAccounts(env);
	if (!current.success) return current;
	const existing = current.data;
	if (!existing || !(name in existing.accounts)) return ok({ removed: false, accounts: existing });
	const { [name]: _gone, ...rest } = existing.accounts;
	const names = Object.keys(rest).sort();
	const first = names[0];
	if (first === undefined) {
		rmSync(credentialsPath(env), { force: true });
		return ok({ removed: true, accounts: undefined });
	}
	const next = existing.default === name ? first : existing.default;
	const written = writeAccounts(env, { version: 2, default: next, accounts: rest });
	return written.success ? ok({ removed: true, accounts: written.data }) : written;
}

export function setDefaultAccount(env: Env, name: string): Result<Accounts> {
	const current = readAccounts(env);
	if (!current.success) return current;
	if (!current.data || !(name in current.data.accounts)) return err(`no account ${name} (warden account list)`);
	return writeAccounts(env, { ...current.data, default: name });
}

/** Forget every saved login; `true` when there was a file. */
export function clearAllAccounts(env: Env): boolean {
	const path = credentialsPath(env);
	if (!existsSync(path)) return false;
	rmSync(path, { force: true });
	return true;
}

/** The default account's login, `undefined` when there is none. */
export function readCredentials(env: Env): Result<Credentials | undefined> {
	const accounts = readAccounts(env);
	if (!accounts.success) return accounts;
	return ok(accounts.data?.accounts[accounts.data.default]);
}

/** Save into the default account (named `default` when nothing is saved yet). */
export function writeCredentials(env: Env, credentials: Credentials): Result<void> {
	const current = readAccounts(env);
	if (!current.success) return current;
	const written = writeAccount(env, current.data?.default ?? DEFAULT_ACCOUNT, credentials);
	return written.success ? ok(undefined) : written;
}

/** Forget the default account's login; `true` when there was one. */
export function clearCredentials(env: Env): boolean {
	const current = readAccounts(env);
	if (!current.success || !current.data) return false;
	const removed = removeAccount(env, current.data.default);
	return removed.success && removed.data.removed;
}
