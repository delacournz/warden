import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { processAlive } from "@delacour/warden-core/liveness";
import { wardenHome } from "@delacour/warden-core/store";
import { ok, type Result } from "@delacour/warden-types/result";

/**
 * What `warden dev` records about a running session so other processes (`dev logs`, the MCP server, `warden ui`) can
 * find it. Checked by hand, not zod: `warden dev --help` must load no zod (`startup.test.ts`).
 */
export type DevSessionRecord = {
	version: 1;
	/** the device lease id; also the directory name under `<WARDEN_HOME>/dev` */
	leaseId: string;
	/** the `warden dev` process; a dead pid makes the record stale */
	pid: number;
	platform: "ios" | "android";
	/** simulator udid / emulator serial */
	deviceId: string;
	port: number;
	metroUrl: string;
	/** where `metro.log` / `warden.log` / broker files live */
	logDir: string;
	projectRoot: string;
	/** ISO time the session became ready */
	startedAt: string;
	/** the CDP broker's Unix socket, once it is listening */
	brokerSocket?: string;
};

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const positiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** `value` as a well-formed record, else undefined. */
export function parseDevSession(value: unknown): DevSessionRecord | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const r = value as Record<string, unknown>;
	const strings = [r.leaseId, r.deviceId, r.metroUrl, r.logDir, r.projectRoot, r.startedAt];
	if (r.version !== 1 || !strings.every(nonEmpty) || !positiveInt(r.pid) || !positiveInt(r.port)) return undefined;
	if (r.platform !== "ios" && r.platform !== "android") return undefined;
	if (r.brokerSocket !== undefined && !nonEmpty(r.brokerSocket)) return undefined;
	return {
		version: 1,
		leaseId: r.leaseId as string,
		pid: r.pid,
		platform: r.platform,
		deviceId: r.deviceId as string,
		port: r.port,
		metroUrl: r.metroUrl as string,
		logDir: r.logDir as string,
		projectRoot: r.projectRoot as string,
		startedAt: r.startedAt as string,
		...(nonEmpty(r.brokerSocket) ? { brokerSocket: r.brokerSocket } : {}),
	};
}

export type DevSessionErrorCode = "no_dev_session" | "ambiguous_dev_session" | "dev_session_io";

export type DevSessionError = { code: DevSessionErrorCode; message: string; hint?: string };

export type DevSessionDeps = { isAlive: (pid: number) => boolean };

export type DevSessionQuery = { udid?: string; projectRoot?: string };

type Env = Record<string, string | undefined>;

const defaultDeps: DevSessionDeps = { isAlive: processAlive };

const sessionError = (code: DevSessionErrorCode, message: string, hint?: string): DevSessionError => ({
	code,
	message,
	...(hint === undefined ? {} : { hint }),
});

/** `<WARDEN_HOME>/dev`, the parent of every session directory. */
export function devSessionsDir(env: Env): string {
	return join(wardenHome(env), "dev");
}

/** `<WARDEN_HOME>/dev/<leaseId>/session.json` */
export function devSessionPath(env: Env, leaseId: string): string {
	return join(devSessionsDir(env), leaseId, "session.json");
}

function readRecord(path: string): DevSessionRecord | undefined {
	try {
		return parseDevSession(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return undefined;
	}
}

/** Writes the record atomically (temp file + rename) and returns its path. */
export function writeDevSession(env: Env, record: DevSessionRecord): Result<string, DevSessionError> {
	const path = devSessionPath(env, record.leaseId);
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
		renameSync(tmp, path);
		return ok(path);
	} catch (error) {
		return { success: false, error: sessionError("dev_session_io", `can't write ${path}: ${String(error)}`) };
	}
}

/** Deletes the record (the rest of the session directory stays: logs outlive the session). A missing record is fine. */
export function removeDevSession(env: Env, leaseId: string): void {
	try {
		rmSync(devSessionPath(env, leaseId), { force: true });
	} catch {
		// best-effort
	}
}

/** Live sessions, newest first. Unreadable, invalid and dead-pid records are skipped. */
export function listDevSessions(
	env: Env,
	deps: DevSessionDeps = defaultDeps
): Result<DevSessionRecord[], DevSessionError> {
	let names: string[];
	try {
		names = readdirSync(devSessionsDir(env));
	} catch {
		return ok([]);
	}
	const sessions: DevSessionRecord[] = [];
	for (const name of names) {
		const record = readRecord(devSessionPath(env, name));
		if (record !== undefined && deps.isAlive(record.pid)) sessions.push(record);
	}
	sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
	return ok(sessions);
}

/** Merges `patch` into the stored record (e.g. the broker adds `brokerSocket`). */
export function updateDevSession(
	env: Env,
	leaseId: string,
	patch: Partial<Omit<DevSessionRecord, "version" | "leaseId">>
): Result<DevSessionRecord, DevSessionError> {
	const current = readRecord(devSessionPath(env, leaseId));
	if (current === undefined)
		return { success: false, error: sessionError("no_dev_session", `no dev session ${leaseId}`) };
	const next: DevSessionRecord = { ...current, ...patch };
	const written = writeDevSession(env, next);
	return written.success ? ok(next) : written;
}

function describeSession(session: DevSessionRecord): string {
	return `${session.deviceId} (${session.platform}, :${session.port}, ${session.projectRoot})`;
}

/**
 * The one live session matching `query` (`udid` = device id, `projectRoot` compared resolved). No match is
 * `no_dev_session`; more than one is `ambiguous_dev_session`, naming each so the caller can pass `--udid`.
 */
export function findDevSession(
	env: Env,
	query: DevSessionQuery,
	deps: DevSessionDeps = defaultDeps
): Result<DevSessionRecord, DevSessionError> {
	const listed = listDevSessions(env, deps);
	if (!listed.success) return listed;
	const root = query.projectRoot === undefined ? undefined : resolve(query.projectRoot);
	const matches = listed.data.filter(
		(s) =>
			(query.udid === undefined || s.deviceId === query.udid) && (root === undefined || resolve(s.projectRoot) === root)
	);
	const [first, ...rest] = matches;
	if (first === undefined) {
		return {
			success: false,
			error: sessionError("no_dev_session", "no running `warden dev` session matches", "start one with `warden dev`"),
		};
	}
	if (rest.length > 0) {
		return {
			success: false,
			error: sessionError(
				"ambiguous_dev_session",
				`${matches.length} running dev sessions: ${matches.map(describeSession).join("; ")}`,
				"pass --udid <id>"
			),
		};
	}
	return ok(first);
}
