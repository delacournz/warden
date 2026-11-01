import { captureCaps } from "@delacour/warden-perf/shared/caps";
import type { PerfSession } from "@delacour/warden-perf/shared/session.schema";
import type { PerfEnv } from "./env";
import { perfSessionStore } from "./session";

/** One recorded perf session as `perf ls` lists it. */
export type SessionRow = {
	id: string;
	device: string;
	platform: string;
	app: string | null;
	/** running · stopped · aborted, or overdue (still `running` on disk past its cap: the next `perf start` sweeps it) */
	status: string;
	startedAt: number;
	maxDurationMs: number;
	marks: number;
};

/** PerfLs: ls. */
export class PerfLs {
	/** The listing row of a session at time `now`. */
	rowOf(session: PerfSession, now: number): SessionRow {
		const overdue =
			session.status === "running" &&
			captureCaps.overCap({ startedWallMs: session.startedAt.wallMs, maxDurationMs: session.maxDurationMs }, now);
		return {
			id: session.id,
			device: session.device.udid,
			platform: session.device.platform,
			app: session.app?.id ?? null,
			status: overdue ? "overdue" : session.status,
			startedAt: session.startedAt.wallMs,
			maxDurationMs: session.maxDurationMs,
			marks: session.marks.length,
		};
	}

	/** Recorded sessions, newest first, optionally only one device's. */
	sessionRows(env: Pick<PerfEnv, "env" | "now">, device?: string): SessionRow[] {
		const now = env.now();
		return perfSessionStore
			.listSessions(env)
			.filter((s) => device === undefined || s.device.udid === device)
			.map((s) => this.rowOf(s, now));
	}
}

export const perfLsOps = new PerfLs();
