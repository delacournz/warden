import { hidRecovery } from "@delacour/warden-driver-ios/hid-recovery";
import type { Exec } from "@delacour/warden-runtime/exec";
import type { Result } from "@delacour/warden-types/result";

/**
 * HID recovery for SDK iOS sessions. On Xcode 27.1, quitting Device Hub invalidates the sim's HID digitizer
 * connection (or shuts the sim down): the sim stays Booted but every tap is discarded. `warden e2e` reboots the sim
 * and re-runs the attempt; an SDK session does the same per call: the first op that fails with that error shuts the
 * sim down, boots it again, reopens the driver and runs the op once more. Once per session, like the e2e runner: a
 * second loss fails as it did before.
 */

/** What the recovery needs from the session; tests replace each member. */
export type HidRecoverySeams = {
	exec: Exec;
	env: Record<string, string | undefined>;
	log: (line: string) => void;
	/** drop the (invalid) driver so the next call opens a fresh one on the rebooted sim */
	resetDriver: () => Promise<void>;
};

/** Whether a failed result is "HID lost", by its error text. */
export function hidLostIn(result: Result<unknown, { message: string }>): boolean {
	return !result.success && hidRecovery.isHidLostMessage(result.error.message);
}

/** `WARDEN_AFTER_REBOOT` (a JSON argv array, `{udid}` replaced): reopen the sim's Device Hub window and tile again. */
function afterRebootArgv(env: Record<string, string | undefined>): string[] | undefined {
	const raw = env.WARDEN_AFTER_REBOOT;
	if (raw === undefined || raw === "") return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) && parsed.every((arg): arg is string => typeof arg === "string") ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Reboot the sim and drop the driver. `true` = the sim is back and the failed op may run again. */
export async function recoverSimHid(seams: HidRecoverySeams, udid: string): Promise<boolean> {
	await seams.resetDriver();
	const rebooted = await hidRecovery.rebootSim({ exec: seams.exec, log: seams.log }, udid);
	if (!rebooted.success) {
		seams.log(`sim ${udid}: HID connection lost, reboot failed: ${rebooted.error}`);
		return false;
	}
	await hidRecovery.runAfterReboot({ exec: seams.exec, log: seams.log }, afterRebootArgv(seams.env), udid);
	seams.log(`sim ${udid}: HID connection lost (Device Hub quit?), rebooted; running the call again`);
	return true;
}
