import type { PerfSession } from "@delacour/warden-perf/shared/session.schema";
import { ok, type Result } from "@delacour/warden-types/result";
import { type UiError, uiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { type PerfDeviceFlags, resolvePerfDevice } from "./device";
import type { PerfDeps } from "./run";
import { listSessions, readSession } from "./session";

const notFound = (message: string): { success: false; error: UiError } => ({
	success: false,
	error: uiError("session_not_found", message, { hint: "warden perf ls" }),
});

/** A session by id, unique id prefix or `latest` (the newest). */
export function sessionByRef(ctx: Pick<CommandContext, "env">, ref: string): Result<PerfSession, UiError> {
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

/**
 * The session a read-only command acts on: the named one, else the newest for the resolved device, else the newest
 * overall (no device needed to read a finished session).
 */
export async function pickSession(
	ctx: CommandContext,
	deps: PerfDeps,
	flags: PerfDeviceFlags,
	ref: string | undefined
): Promise<Result<PerfSession, UiError>> {
	if (ref !== undefined) return sessionByRef(ctx, ref);
	const sessions = listSessions(ctx);
	const device = await resolvePerfDevice(ctx, flags, "observe", deps.device);
	const mine = device.success ? sessions.find((s) => s.device.udid === device.data.udid) : undefined;
	const chosen = mine ?? sessions[0];
	return chosen === undefined ? notFound("no perf sessions yet") : ok(chosen);
}
