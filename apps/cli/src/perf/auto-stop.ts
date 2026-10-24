import type { CommandContext } from "../context";
import { readSession, type SessionDeps, stopSession } from "./session";

export type AutoStopDeps = {
	sleep: (ms: number) => Promise<void>;
	/** abort = the collector was told to stop (SIGTERM/SIGINT): leave the session to whoever stopped it */
	signal?: AbortSignal;
	/** longest single sleep, so a stop or an abort is noticed (default 1 s) */
	tickMs?: number;
};

/** `capped` = the session hit its `maxDurationMs` and was stopped · `ended` = someone else stopped it · `missing` = no such session · `aborted` = told to stop. */
export type AutoStopOutcome = "capped" | "ended" | "missing" | "aborted";

/**
 * The collector's auto-stop timer: sleeps until the session's cap, then stops it with `max-duration` (without
 * signalling itself). Returns early when the session is stopped by someone else, vanishes or the signal aborts.
 */
export async function runAutoStop(
	ctx: Pick<CommandContext, "env" | "now" | "store">,
	sessionDeps: SessionDeps,
	id: string,
	deps: AutoStopDeps
): Promise<AutoStopOutcome> {
	const tick = deps.tickMs ?? 1_000;
	for (;;) {
		const session = readSession(ctx, id);
		if (session === undefined) return "missing";
		if (session.status !== "running") return "ended";
		const remaining = session.startedAt.wallMs + session.maxDurationMs - ctx.now();
		if (remaining <= 0) {
			stopSession(ctx, sessionDeps, id, "max-duration", { signalCollector: false });
			return "capped";
		}
		if (deps.signal?.aborted) return "aborted";
		await deps.sleep(Math.min(remaining, tick));
	}
}
