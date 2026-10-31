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

/**
 * How a command authenticates: `env` = `WARDEN_TOKEN` (CI), `saved` = `$WARDEN_HOME/auth.json`, `none` = not
 * logged in to `apiUrl`.
 */
export type ResolvedAuth =
	| { kind: "env"; apiUrl: string; token: string }
	| { kind: "saved"; apiUrl: string; credentials: Credentials }
	| { kind: "none"; apiUrl: string };

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

/** The saved login, `undefined` when there is none; a damaged file is an error (re-run `warden login`). */
export function readCredentials(env: Env): Result<Credentials | undefined> {
	const path = credentialsPath(env);
	if (!existsSync(path)) return ok(undefined);
	try {
		const parsed = parseCredentials(JSON.parse(readFileSync(path, "utf8")));
		return parsed ? ok(parsed) : err(`${path} is not a warden login; run warden login again`);
	} catch (e) {
		return err(`${path}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** Save atomically (temp file + rename), readable by the owner only. */
export function writeCredentials(env: Env, credentials: Credentials): Result<void> {
	const path = credentialsPath(env);
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		mkdirSync(wardenHome(env), { recursive: true });
		writeFileSync(tmp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, path);
		return ok(undefined);
	} catch (e) {
		rmSync(tmp, { force: true });
		return err(`could not save ${path}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** Forget the saved login; `true` when there was one. */
export function clearCredentials(env: Env): boolean {
	const path = credentialsPath(env);
	if (!existsSync(path)) return false;
	rmSync(path, { force: true });
	return true;
}

/**
 * `WARDEN_TOKEN` wins (CI, with `WARDEN_API_URL` or the default); then the saved login, but only for the api it
 * was issued by, so pointing `WARDEN_API_URL` at staging never sends a production token.
 */
export function resolveAuth(env: Env): Result<ResolvedAuth> {
	const override = env.WARDEN_API_URL?.replace(/\/+$/, "") || undefined;
	if (env.WARDEN_TOKEN) return ok({ kind: "env", apiUrl: override ?? DEFAULT_API_URL, token: env.WARDEN_TOKEN });
	const saved = readCredentials(env);
	if (!saved.success) return saved;
	const credentials = saved.data;
	if (credentials && (override === undefined || override === credentials.apiUrl)) {
		return ok({ kind: "saved", apiUrl: credentials.apiUrl, credentials });
	}
	return ok({ kind: "none", apiUrl: override ?? DEFAULT_API_URL });
}
