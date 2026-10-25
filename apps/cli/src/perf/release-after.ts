import { readFileSync } from "node:fs";
import { join } from "node:path";
import { uiDir } from "../agent-ui/paths";
import { stopHelperAfter } from "../agent-ui/stop-helper-after";
import type { CommandContext } from "../context";

type Host = Pick<CommandContext, "env" | "now" | "err">;

/** The session id the device's `state.json` points at, read as plain JSON (no schema, no perf package). */
export function recordedPerfSession(host: Pick<CommandContext, "env">, udid: string): string | undefined {
	try {
		const state: unknown = JSON.parse(readFileSync(join(uiDir(host, udid), "state.json"), "utf8"));
		if (typeof state !== "object" || state === null || !("perf" in state)) return undefined;
		const { perf } = state;
		if (typeof perf !== "object" || perf === null || !("sessionId" in perf)) return undefined;
		return typeof perf.sessionId === "string" ? perf.sessionId : undefined;
	} catch {
		return undefined;
	}
}

export type StopRunner = (ctx: Host, sessionId: string) => Promise<void>;

/** Finalizes the session (reason `device-released`); the orchestrator and the perf package load only here. */
const finalizeRecorded: StopRunner = async (ctx, sessionId) => {
	const [{ finalizeSession, defaultSessionKit }, { defaultPerfDeps }] = await Promise.all([
		import("./orchestrate"),
		import("./run"),
	]);
	const full = ctx as CommandContext;
	const stopped = await finalizeSession(full, defaultPerfDeps, defaultSessionKit, sessionId, {
		reason: "device-released",
		analyze: false,
	});
	if (!stopped.success) ctx.err(`warden: perf session ${sessionId} not stopped: ${stopped.error.message}`);
};

/**
 * `after` hook for `releaseDevices`: a device released with a running perf session ends it first (report built
 * without native analysis). Reads `state.json` as plain JSON, so a release with no session never loads perf code.
 */
export function stopPerfAfter(ctx: Host, run: StopRunner = finalizeRecorded): (udid: string) => Promise<void> {
	return async (udid) => {
		const id = recordedPerfSession(ctx, udid);
		if (id === undefined) return;
		try {
			await run(ctx, id);
		} catch (error) {
			ctx.err(`warden: perf session ${id} not stopped: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
}

/** `stopPerfAfter` then, when `helper`, the `warden-simd` stop that `release --shutdown` / `ui close --release` do. */
export function releaseAfter(ctx: Host, opts: { helper: boolean }): (udid: string) => Promise<void> {
	const perf = stopPerfAfter(ctx);
	const helper = opts.helper ? stopHelperAfter(ctx) : undefined;
	return async (udid) => {
		await perf(udid);
		await helper?.(udid);
	};
}
