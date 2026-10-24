import type { Exec } from "@delacour/warden-core/exec";
import { execError } from "@delacour/warden-core/exec";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { E2eError } from "../../errors";

/**
 * Recovering a sim whose HID digitizer connection was invalidated (`E_HID`: "The dtuhidd connection … has been
 * invalidated"). Seen on Xcode 27.1 when Device Hub, which had the sim open, quit: the sim stays Booted but every tap
 * is discarded until it reboots.
 */

const SHUTDOWN_MS = 60_000;
const BOOT_MS = 120_000;
/** `simctl shutdown` on a sim that is already shut down. */
const ALREADY_SHUTDOWN = 164;

export type HidRecoveryDeps = {
	exec: Exec;
	log?: (line: string) => void;
};

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
	if (shutdown.exitCode !== 0 && shutdown.exitCode !== ALREADY_SHUTDOWN) return err(execError(down, shutdown));
	const up = ["xcrun", "simctl", "bootstatus", udid, "-b"];
	const boot = await deps.exec(up, { timeoutMs: BOOT_MS });
	return boot.exitCode === 0 ? ok(undefined) : err(execError(up, boot));
}
