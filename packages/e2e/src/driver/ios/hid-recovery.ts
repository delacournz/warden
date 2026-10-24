import { existsSync } from "node:fs";
import type { Exec } from "@delacour/warden-core/exec";
import { execError } from "@delacour/warden-core/exec";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { E2eError } from "../../errors";
import { connectSimd } from "./simd-client";

/**
 * Recovering a sim whose HID digitizer connection was invalidated (`E_HID`: "The dtuhidd connection … has been
 * invalidated"). Seen on Xcode 27.1 when Device Hub, which had the sim open, quit: the sim stays Booted but every tap
 * is discarded until it reboots.
 */

const SHUTDOWN_MS = 60_000;
const BOOT_MS = 120_000;
/** `simctl shutdown` on a sim that is already shut down: exit 164, or 149 with this text (Xcode 27.1). */
const ALREADY_SHUTDOWN_EXIT = 164;
const ALREADY_SHUTDOWN_TEXT = "current state: Shutdown";

export type HidRecoveryDeps = {
	exec: Exec;
	log?: (line: string) => void;
	/** attach to the resident helper's socket (default {@link connectSimd}) */
	connect?: typeof connectSimd;
	/** whether the socket file is still there (default: `existsSync`) */
	socketExists?: (path: string) => boolean;
	sleep?: (ms: number) => Promise<void>;
};

const STOP_WAIT_MS = 2_000;
const STOP_POLL_MS = 50;
const SHUTDOWN_REQUEST_MS = 500;

/**
 * Stops the resident `warden-simd` daemon on `socketPath` (the warm one `warden e2e` started): it is bound to the
 * boot that just ended, and the reopened driver would otherwise attach to it and hit `E_HID` again. Asks it to
 * `shutdown` and waits for the socket to go; with no daemon there (a stdio helper dies with its driver) nothing
 * is done. The next driver open spawns a helper on the new boot.
 */
export async function stopResidentHelper(deps: HidRecoveryDeps, socketPath: string): AsyncResult<"stopped" | "none"> {
	const connect = deps.connect ?? connectSimd;
	const exists = deps.socketExists ?? existsSync;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const attached = await connect({ socketPath });
	if (!attached.success) return ok("none");
	await attached.data.request("shutdown", {}, { timeoutMs: SHUTDOWN_REQUEST_MS });
	await attached.data.close();
	for (let waited = 0; waited < STOP_WAIT_MS; waited += STOP_POLL_MS) {
		if (!exists(socketPath)) return ok("stopped");
		await sleep(STOP_POLL_MS);
	}
	return exists(socketPath) ? err(`warden-simd on ${socketPath} did not stop`) : ok("stopped");
}

/** The error of a tap/swipe/type on a sim whose HID connection is gone (wrapped as `ACTION_FAILED` or `DRIVER`). */
export function isHidLost(error: unknown): boolean {
	return (
		error instanceof E2eError &&
		(error.code === "ACTION_FAILED" || error.code === "DRIVER") &&
		/\bE_HID\b/.test(error.message) &&
		/dtuhidd connection[\s\S]*invalidated/.test(error.message)
	);
}

/**
 * Shuts the sim down and boots it again: `bootstatus -b` boots a shut-down sim itself and waits for it, and opens
 * no Simulator.app window (the same windowless path warden claims use). The caller reconnects the helper and
 * relaunches the app.
 */
export async function rebootSim(deps: HidRecoveryDeps, udid: string): AsyncResult<void> {
	const down = ["xcrun", "simctl", "shutdown", udid];
	const shutdown = await deps.exec(down, { timeoutMs: SHUTDOWN_MS });
	const already = shutdown.exitCode === ALREADY_SHUTDOWN_EXIT || shutdown.stderr.includes(ALREADY_SHUTDOWN_TEXT);
	if (shutdown.exitCode !== 0 && !already) return err(execError(down, shutdown));
	const up = ["xcrun", "simctl", "bootstatus", udid, "-b"];
	const boot = await deps.exec(up, { timeoutMs: BOOT_MS });
	return boot.exitCode === 0 ? ok(undefined) : err(execError(up, boot));
}
