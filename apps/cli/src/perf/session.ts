import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type PidAlive, processAlive } from "@delacour/warden-core/liveness";
import { overCap } from "@delacour/warden-perf/shared/caps";
import {
	formatSessionId,
	isSessionId,
	type PerfSession,
	parseSession,
	SESSION_FILE,
	type STOP_REASONS,
} from "@delacour/warden-perf/shared/session.schema";
import { ok, type Result } from "@delacour/warden-types/result";
import { type UiError, uiError } from "../agent-ui/output";
import {
	type PidIdentity,
	type ProcessCommand,
	processCommand,
	recordedIdentity,
	safeToSignal,
} from "../agent-ui/process-identity";
import { readState, updateState, writeFileAtomic } from "../agent-ui/state";
import type { CommandContext } from "../context";
import { perfRoot, sessionDir } from "./paths";

export { sessionDir };

type SessionHost = Pick<CommandContext, "env" | "now" | "store">;

/** What the session store reaches the process table through; tests inject fakes. */
export type SessionDeps = {
	pidAlive: PidAlive;
	/** a pid's command line: the collector is signalled only while it still carries the session. Absent: liveness alone */
	command?: ProcessCommand | undefined;
	kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
	/** six hex chars that make a session id unique within one second */
	random: () => string;
};

export const defaultSessionDeps: SessionDeps = {
	pidAlive: processAlive,
	command: processCommand,
	kill: (pid, signal) => {
		try {
			process.kill(pid, signal);
		} catch {
			// already gone
		}
	},
	random: () => randomBytes(3).toString("hex"),
};

export type StopReason = (typeof STOP_REASONS)[number];

export type NewSession = Pick<PerfSession, "device" | "target" | "maxDurationMs"> &
	Partial<Pick<PerfSession, "app">> & { deviceWallMs?: number };

const identityOf = (deps: SessionDeps): PidIdentity => ({ pidAlive: deps.pidAlive, command: deps.command });

/** What a collector's command line carries (`perf-collect --session <id>`): tells it from a reused pid. */
const collectorMarks = (id: string): string[] => ["perf-collect", `--session ${id}`];

function collectorPid(session: PerfSession): number | undefined {
	return session.capturers.find((c) => c.kind === "collector" && c.state === "running")?.pid;
}

/** A session with no collector is live while running; with one, while its pid may still be the collector warden started. */
function collectorAlive(deps: SessionDeps, session: PerfSession): boolean {
	const pid = collectorPid(session);
	if (pid === undefined) return true;
	const identity = recordedIdentity(identityOf(deps), pid, collectorMarks(session.id));
	return identity === "match" || identity === "unknown";
}

function writeSession(ctx: SessionHost, session: PerfSession): void {
	const dir = sessionDir(ctx, session.id);
	mkdirSync(dir, { recursive: true });
	writeFileAtomic(join(dir, SESSION_FILE), `${JSON.stringify(session, null, 2)}\n`);
}

/** `session.json` of `id`; undefined for an unknown, malformed or unreadable one (the id is validated before it touches a path). */
export function readSession(ctx: Pick<CommandContext, "env">, id: string): PerfSession | undefined {
	if (!isSessionId(id)) return undefined;
	try {
		const parsed = parseSession(JSON.parse(readFileSync(join(sessionDir(ctx, id), SESSION_FILE), "utf8")));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Read-modify-write of `session.json` under the store's `BEGIN IMMEDIATE` transaction (the cross-process mutex), so
 * `mark`, the collector and `stop` never lose each other's edits. Returns the session as written, or undefined when
 * there is no such session.
 */
export function updateSession(
	ctx: SessionHost,
	id: string,
	update: (session: PerfSession) => PerfSession
): PerfSession | undefined {
	return ctx.store().transaction(() => {
		const current = readSession(ctx, id);
		if (current === undefined) return undefined;
		const next = update(current);
		if (next !== current) writeSession(ctx, next);
		return next;
	});
}

/** Every session on disk, newest first. */
export function listSessions(ctx: Pick<CommandContext, "env">): PerfSession[] {
	let names: string[];
	try {
		names = readdirSync(perfRoot(ctx));
	} catch {
		return [];
	}
	return names
		.filter(isSessionId)
		.flatMap((id) => readSession(ctx, id) ?? [])
		.sort((a, b) => b.startedAt.wallMs - a.startedAt.wallMs || (a.id < b.id ? 1 : -1));
}

function clearDevicePointer(ctx: SessionHost, session: PerfSession): void {
	updateState(ctx, session.device.udid, (state) =>
		state.perf?.sessionId === session.id ? { ...state, perf: undefined } : state
	);
}

function finish(
	ctx: SessionHost,
	session: PerfSession,
	status: "stopped" | "aborted",
	reason: StopReason
): PerfSession {
	const next = updateSession(ctx, session.id, (s) => ({
		...s,
		status,
		stopReason: reason,
		stoppedAt: ctx.now(),
		capturers: s.capturers.map((c) => (c.state === "running" ? { ...c, state: "stopped" as const } : c)),
	}));
	clearDevicePointer(ctx, session);
	return next ?? session;
}

/**
 * Stop a session: SIGTERM its collector only when `safeToSignal` proves the pid is still the process warden started
 * (a reused pid, or one whose command line cannot be read, is never signalled), then record the stop.
 */
export function stopSession(
	ctx: SessionHost,
	deps: SessionDeps,
	id: string,
	reason: StopReason,
	opts: { signalCollector?: boolean } = {}
): PerfSession | undefined {
	const session = readSession(ctx, id);
	if (session === undefined) return undefined;
	if (session.status !== "running") return session;
	const pid = collectorPid(session);
	if (opts.signalCollector !== false && pid !== undefined && safeToSignal(identityOf(deps), pid, collectorMarks(id)))
		deps.kill(pid, "SIGTERM");
	return finish(ctx, session, reason === "stale" ? "aborted" : "stopped", reason);
}

/** Settle one running session: over its cap → stopped (`max-duration`); collector gone → aborted (`stale`). */
function sweepOne(ctx: SessionHost, deps: SessionDeps, session: PerfSession): StopReason | undefined {
	if (session.status !== "running") return undefined;
	if (overCap({ startedWallMs: session.startedAt.wallMs, maxDurationMs: session.maxDurationMs }, ctx.now())) {
		stopSession(ctx, deps, session.id, "max-duration");
		return "max-duration";
	}
	if (!collectorAlive(deps, session)) {
		stopSession(ctx, deps, session.id, "stale");
		return "stale";
	}
	return undefined;
}

/** Settle every running session (see `sweepOne`). `perf start` runs this first so a crashed or overdue session never blocks a device. */
export function sweepSessions(ctx: SessionHost, deps: SessionDeps): Array<{ id: string; reason: StopReason }> {
	return listSessions(ctx).flatMap((session) => {
		const reason = sweepOne(ctx, deps, session);
		return reason === undefined ? [] : [{ id: session.id, reason }];
	});
}

/** The device's running session, if it is still within its cap and its collector is alive. */
export function activeSessionFor(ctx: SessionHost, deps: SessionDeps, udid: string): PerfSession | undefined {
	const id = readState(ctx, udid).perf?.sessionId;
	const session = id === undefined ? undefined : readSession(ctx, id);
	if (session === undefined || session.status !== "running") return undefined;
	const expired = overCap({ startedWallMs: session.startedAt.wallMs, maxDurationMs: session.maxDurationMs }, ctx.now());
	return expired || !collectorAlive(deps, session) ? undefined : session;
}

/**
 * Open a session on the device. One per device, whoever owns the lease: a live one is `session_active` (naming it),
 * a dead or overdue one is swept first. The device's `state.json` records the id so `mark` and `stop` find it.
 */
export function createSession(ctx: SessionHost, deps: SessionDeps, input: NewSession): Result<PerfSession, UiError> {
	return ctx.store().transaction((): Result<PerfSession, UiError> => {
		const udid = input.device.udid;
		const existingId = readState(ctx, udid).perf?.sessionId;
		const existing = existingId === undefined ? undefined : readSession(ctx, existingId);
		if (existing !== undefined) sweepOne(ctx, deps, existing);
		const live = existingId === undefined ? undefined : readSession(ctx, existingId);
		if (live?.status === "running") {
			return {
				success: false,
				error: uiError("session_active", `perf session ${live.id} is already running on ${udid}`, {
					hint: "see warden perf ls",
					details: { sessionId: live.id, owner: live.target.holder ?? null },
				}),
			};
		}
		const now = ctx.now();
		const session: PerfSession = {
			version: 1,
			id: formatSessionId(now, deps.random()),
			device: input.device,
			target: input.target,
			...(input.app !== undefined ? { app: input.app } : {}),
			startedAt: { wallMs: now, ...(input.deviceWallMs !== undefined ? { deviceWallMs: input.deviceWallMs } : {}) },
			maxDurationMs: input.maxDurationMs,
			status: "running",
			capturers: [],
			marks: [],
		};
		writeSession(ctx, session);
		updateState(ctx, udid, (state) => ({ ...state, perf: { sessionId: session.id } }));
		return ok(session);
	});
}
