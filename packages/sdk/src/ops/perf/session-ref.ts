import type { PerfSession } from "@delacour/warden-perf/shared/session.schema";
import type { WardenError } from "@delacour/warden-types/error";
import { ok, type Result } from "@delacour/warden-types/result";
import { opError } from "../errors";
import type { PerfEnv } from "./env";
import { listSessions, readSession } from "./session";

export const notFound = (message: string): { success: false; error: WardenError } => ({
	success: false,
	error: opError("session_not_found", message, { hint: "warden perf ls" }),
});

/** A session by id, unique id prefix or `latest` (the newest). */
export function sessionByRef(ctx: Pick<PerfEnv, "env">, ref: string): Result<PerfSession, WardenError> {
	const sessions = listSessions(ctx);
	if (ref === "latest") {
		const newest = sessions[0];
		return newest === undefined ? notFound("no perf sessions yet") : ok(newest);
	}
	const exact = readSession(ctx, ref);
	if (exact !== undefined) return ok(exact);
	const matches = sessions.filter((s) => s.id.startsWith(ref));
	if (matches.length === 1 && matches[0] !== undefined) return ok(matches[0]);
	if (matches.length > 1)
		return notFound(`"${ref}" matches ${matches.length} sessions: ${matches.map((s) => s.id).join(", ")}`);
	return notFound(`no perf session ${ref}`);
}
