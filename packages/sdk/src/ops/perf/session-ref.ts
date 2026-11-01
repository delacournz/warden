import type { PerfSession } from "@delacour/warden-perf/shared/session.schema";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { opErrors } from "../errors";
import type { PerfEnv } from "./env";
import { perfSessionStore } from "./session";

/** PerfSessionRefs: session ref. */
export class PerfSessionRefs {
	readonly notFound = (message: string): { success: false; error: WardenError } => ({
		success: false,
		error: opErrors.opError("session_not_found", message, { hint: "warden perf ls" }),
	});

	/** A session by id, unique id prefix or `latest` (the newest). */
	sessionByRef(ctx: Pick<PerfEnv, "env">, ref: string): Result<PerfSession, WardenError> {
		const sessions = perfSessionStore.listSessions(ctx);
		if (ref === "latest") {
			const newest = sessions[0];
			return newest === undefined ? this.notFound("no perf sessions yet") : resultFactory.ok(newest);
		}
		const exact = perfSessionStore.readSession(ctx, ref);
		if (exact !== undefined) return resultFactory.ok(exact);
		const matches = sessions.filter((s) => s.id.startsWith(ref));
		if (matches.length === 1 && matches[0] !== undefined) return resultFactory.ok(matches[0]);
		if (matches.length > 1)
			return this.notFound(`"${ref}" matches ${matches.length} sessions: ${matches.map((s) => s.id).join(", ")}`);
		return this.notFound(`no perf session ${ref}`);
	}
}

export const perfSessionRefs = new PerfSessionRefs();
