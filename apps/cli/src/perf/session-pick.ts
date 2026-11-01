import type { PerfSession } from "@delacour/warden-perf/shared/session.schema";
import { perfSessionStore } from "@delacour/warden-sdk/ops/perf/session";
import { perfSessionRefs } from "@delacour/warden-sdk/ops/perf/session-ref";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type { UiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { type PerfDeviceFlags, resolvePerfDevice } from "./device";
import type { PerfDeps } from "./run";

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
	if (ref !== undefined) return perfSessionRefs.sessionByRef(ctx, ref);
	const sessions = perfSessionStore.listSessions(ctx);
	const device = await resolvePerfDevice(ctx, flags, "observe", deps.device);
	const mine = device.success ? sessions.find((s) => s.device.udid === device.data.udid) : undefined;
	const chosen = mine ?? sessions[0];
	return chosen === undefined ? perfSessionRefs.notFound("no perf sessions yet") : resultFactory.ok(chosen);
}
