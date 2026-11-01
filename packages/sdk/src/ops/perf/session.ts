import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { captureCaps } from "@delacour/warden-perf/shared/caps";
import {
	type PerfSession,
	SESSION_FILE,
	type STOP_REASONS,
	sessionCodec,
} from "@delacour/warden-perf/shared/session.schema";
import { liveness, type PidAlive } from "@delacour/warden-store/liveness";
import {
	type PidIdentity,
	type ProcessCommand,
	processCommand,
	processIdentity,
} from "@delacour/warden-store/process-identity";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { opErrors } from "../errors";
import { perfDeviceState } from "./device-state";
import type { PerfEnv } from "./env";
import { perfPaths } from "./paths";

type SessionHost = Pick<PerfEnv, "env" | "now" | "store">;

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
	pidAlive: liveness.processAlive,
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

/** PerfSessionStore: session. */
export class PerfSessionStore {
	private readonly identityOf = (deps: SessionDeps): PidIdentity => ({
		pidAlive: deps.pidAlive,
		command: deps.command,
	});

	/** What a collector's command line carries (`perf-collect --session <id>`): tells it from a reused pid. */
	private readonly collectorMarks = (id: string): string[] => ["perf-collect", `--session ${id}`];

	/** The collector's pid while the session still records it as running. */
	collectorPid(session: PerfSession): number | undefined {
		return session.capturers.find((c) => c.kind === "collector" && c.state === "running")?.pid;
	}

	/** A session with no collector is live while running; with one, while its pid may still be the collector warden started. */
	private collectorAlive(deps: SessionDeps, session: PerfSession): boolean {
		const pid = this.collectorPid(session);
		if (pid === undefined) return true;
		const identity = processIdentity.recordedIdentity(this.identityOf(deps), pid, this.collectorMarks(session.id));
		return identity === "match" || identity === "unknown";
	}

	private writeSession(ctx: SessionHost, session: PerfSession): void {
		const dir = perfPaths.sessionDir(ctx, session.id);
		mkdirSync(dir, { recursive: true });
		perfDeviceState.writeFileAtomic(join(dir, SESSION_FILE), `${JSON.stringify(session, null, 2)}\n`);
	}

	/** `session.json` of `id`; undefined for an unknown, malformed or unreadable one (the id is validated before it touches a path). */
	readSession(ctx: Pick<PerfEnv, "env">, id: string): PerfSession | undefined {
		if (!sessionCodec.isSessionId(id)) return undefined;
		try {
			const parsed = sessionCodec.parseSession(
				JSON.parse(readFileSync(join(perfPaths.sessionDir(ctx, id), SESSION_FILE), "utf8"))
			);
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
	updateSession(ctx: SessionHost, id: string, update: (session: PerfSession) => PerfSession): PerfSession | undefined {
		return ctx.store().transaction(() => {
			const current = this.readSession(ctx, id);
			if (current === undefined) return undefined;
			const next = update(current);
			if (next !== current) this.writeSession(ctx, next);
			return next;
		});
	}

	/** Every session on disk, newest first. */
	listSessions(ctx: Pick<PerfEnv, "env">): PerfSession[] {
		let names: string[];
		try {
			names = readdirSync(perfPaths.perfRoot(ctx));
		} catch {
			return [];
		}
		return names
			.filter(sessionCodec.isSessionId.bind(sessionCodec))
			.flatMap((id) => this.readSession(ctx, id) ?? [])
			.sort((a, b) => b.startedAt.wallMs - a.startedAt.wallMs || (a.id < b.id ? 1 : -1));
	}

	private clearDevicePointer(ctx: SessionHost, session: PerfSession): void {
		ctx.store().transaction(() => {
			if (perfDeviceState.readPerfPointer(ctx, session.device.udid) === session.id)
				perfDeviceState.setPerfPointer(ctx, session.device.udid, undefined);
		});
	}

	private finish(
		ctx: SessionHost,
		session: PerfSession,
		status: "stopped" | "aborted",
		reason: StopReason
	): PerfSession {
		const next = this.updateSession(ctx, session.id, (s) => ({
			...s,
			status,
			stopReason: reason,
			stoppedAt: ctx.now(),
			capturers: s.capturers.map((c) => (c.state === "running" ? { ...c, state: "stopped" as const } : c)),
		}));
		this.clearDevicePointer(ctx, session);
		return next ?? session;
	}

	/**
	 * SIGTERM the session's collector, but only when `safeToSignal` proves the pid is still the process warden started.
	 * Returns the pid it signalled (undefined: none recorded, or not provably ours).
	 */
	signalCollector(deps: SessionDeps, session: PerfSession): number | undefined {
		const pid = this.collectorPid(session);
		if (pid === undefined || !processIdentity.safeToSignal(this.identityOf(deps), pid, this.collectorMarks(session.id)))
			return undefined;
		deps.kill(pid, "SIGTERM");
		return pid;
	}

	/**
	 * Stop a session: SIGTERM its collector only when `safeToSignal` proves the pid is still the process warden started
	 * (a reused pid, or one whose command line cannot be read, is never signalled), then record the stop.
	 */
	stopSession(
		ctx: SessionHost,
		deps: SessionDeps,
		id: string,
		reason: StopReason,
		opts: { signalCollector?: boolean } = {}
	): PerfSession | undefined {
		const session = this.readSession(ctx, id);
		if (session === undefined) return undefined;
		if (session.status !== "running") return session;
		if (opts.signalCollector !== false) this.signalCollector(deps, session);
		return this.finish(ctx, session, reason === "stale" ? "aborted" : "stopped", reason);
	}

	/** Settle one running session: over its cap → stopped (`max-duration`); collector gone → aborted (`stale`). */
	private sweepOne(ctx: SessionHost, deps: SessionDeps, session: PerfSession): StopReason | undefined {
		if (session.status !== "running") return undefined;
		if (
			captureCaps.overCap({ startedWallMs: session.startedAt.wallMs, maxDurationMs: session.maxDurationMs }, ctx.now())
		) {
			this.stopSession(ctx, deps, session.id, "max-duration");
			return "max-duration";
		}
		if (!this.collectorAlive(deps, session)) {
			this.stopSession(ctx, deps, session.id, "stale");
			return "stale";
		}
		return undefined;
	}

	/** Settle every running session (see `sweepOne`). `perf start` runs this first so a crashed or overdue session never blocks a device. */
	sweepSessions(ctx: SessionHost, deps: SessionDeps): Array<{ id: string; reason: StopReason }> {
		return this.listSessions(ctx).flatMap((session) => {
			const reason = this.sweepOne(ctx, deps, session);
			return reason === undefined ? [] : [{ id: session.id, reason }];
		});
	}

	/** The device's running session, if it is still within its cap and its collector is alive. */
	activeSessionFor(ctx: SessionHost, deps: SessionDeps, udid: string): PerfSession | undefined {
		const id = perfDeviceState.readPerfPointer(ctx, udid);
		const session = id === undefined ? undefined : this.readSession(ctx, id);
		if (session === undefined || session.status !== "running") return undefined;
		const expired = captureCaps.overCap(
			{ startedWallMs: session.startedAt.wallMs, maxDurationMs: session.maxDurationMs },
			ctx.now()
		);
		return expired || !this.collectorAlive(deps, session) ? undefined : session;
	}

	/** The session the device's `state.json` points at while it is still `running` on disk, even past its cap (`perf stop` still has captures to gather). */
	runningSessionFor(ctx: SessionHost, udid: string): PerfSession | undefined {
		const id = perfDeviceState.readPerfPointer(ctx, udid);
		const session = id === undefined ? undefined : this.readSession(ctx, id);
		return session?.status === "running" ? session : undefined;
	}

	/**
	 * Open a session on the device. One per device, whoever owns the lease: a live one is `session_active` (naming it),
	 * a dead or overdue one is swept first. The device's `state.json` records the id so `mark` and `stop` find it.
	 */
	createSession(ctx: SessionHost, deps: SessionDeps, input: NewSession): Result<PerfSession, WardenError> {
		return ctx.store().transaction((): Result<PerfSession, WardenError> => {
			const udid = input.device.udid;
			const existingId = perfDeviceState.readPerfPointer(ctx, udid);
			const existing = existingId === undefined ? undefined : this.readSession(ctx, existingId);
			if (existing !== undefined) this.sweepOne(ctx, deps, existing);
			const live = existingId === undefined ? undefined : this.readSession(ctx, existingId);
			if (live?.status === "running") {
				return {
					success: false,
					error: opErrors.opError("session_active", `perf session ${live.id} is already running on ${udid}`, {
						hint: "warden perf start --join attaches read-only to it; warden perf stop ends it",
						details: { sessionId: live.id, owner: live.target.holder ?? null },
					}),
				};
			}
			const now = ctx.now();
			const session: PerfSession = {
				version: 1,
				id: sessionCodec.formatSessionId(now, deps.random()),
				device: input.device,
				target: input.target,
				...(input.app !== undefined ? { app: input.app } : {}),
				startedAt: { wallMs: now, ...(input.deviceWallMs !== undefined ? { deviceWallMs: input.deviceWallMs } : {}) },
				maxDurationMs: input.maxDurationMs,
				status: "running",
				capturers: [],
				marks: [],
			};
			this.writeSession(ctx, session);
			perfDeviceState.setPerfPointer(ctx, udid, session.id);
			return resultFactory.ok(session);
		});
	}
}

export const perfSessionStore = new PerfSessionStore();
