import type { Exec } from "@delacour/warden-core/exec";
import type { DeviceProvider } from "@delacour/warden-core/providers/provider.types";

/**
 * What a simulator's AXRuntime logs when the accessibility notification server in backboardd stopped answering:
 * every in-sim AX client (SpringBoard, AccessibilityUIServer, the app, the axbridge guest) then blocks for good on
 * its broadcasts and observer registrations, so both readers time out for the life of that boot. A freshly cloned
 * sim lands in this state on its first accessibility use now and then (CI: ~15% per sim). Restarting SpringBoard
 * does not clear it; restarting backboardd does. A healthy sim never logs this line.
 */
export const AX_WEDGE_MARKER = "Could not auto-register for pid status change";

/** The in-sim launchd service that hosts the AX notification server (`AXBackBoardServer`). */
const BACKBOARDD = "user/foreground/com.apple.backboardd";

/** How far back the log is searched for the marker: the warm-up asks within a minute or two of the first read. */
const LOG_WINDOW = "5m";
const LOG_TIMEOUT_MS = 20_000;
const KICKSTART_TIMEOUT_MS = 20_000;

/**
 * One recovery attempt's outcome: `recovered` means backboardd (and SpringBoard with it) was restarted. A failure names
 * its stage: `log` (the marker could not be looked for: the sim may not be wedged at all) or `restart` (it is wedged and
 * backboardd could not be restarted: only a reboot is left).
 */
export type AxRecovery =
	| { kind: "recovered"; note: string }
	| { kind: "not-wedged" }
	| { kind: "failed"; stage: "log" | "restart"; error: string };

/**
 * Whether `log show` output has the marker on a line of its own: `log show` logs its own invocation, args included,
 * so that line names the marker on every sim (the predicate also leaves `log`'s lines out).
 */
export function logNamesWedge(stdout: string): boolean {
	return stdout
		.split("\n")
		.some((line) => line.includes(AX_WEDGE_MARKER) && !line.includes("log run noninteractively"));
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const lastLine = (text: string, fallback: string): string => text.trim().split("\n").pop() || fallback;

/**
 * Look for the wedge marker in the simulator's log and, when it is there, restart backboardd
 * (`launchctl kickstart -k`, which takes SpringBoard and the foreground app with it). Running apps and any
 * axbridge guest are left talking to the dead server: the caller must start a fresh helper afterwards. Never throws.
 */
export async function recoverAxWedge(exec: Exec, udid: string): Promise<AxRecovery> {
	let stage: "log" | "restart" = "log";
	try {
		const log = await exec(
			[
				"xcrun",
				"simctl",
				"spawn",
				udid,
				"log",
				"show",
				"--last",
				LOG_WINDOW,
				"--style",
				"compact",
				"--predicate",
				`eventMessage CONTAINS "${AX_WEDGE_MARKER}" AND process != "log"`,
			],
			{ timeoutMs: LOG_TIMEOUT_MS }
		);
		if (log.exitCode !== 0)
			return { kind: "failed", stage: "log", error: `log show: ${lastLine(log.stderr, `exit ${log.exitCode}`)}` };
		if (!logNamesWedge(log.stdout)) return { kind: "not-wedged" };
		stage = "restart";
		const kick = await exec(["xcrun", "simctl", "spawn", udid, "launchctl", "kickstart", "-k", BACKBOARDD], {
			timeoutMs: KICKSTART_TIMEOUT_MS,
		});
		if (kick.exitCode !== 0) {
			return {
				kind: "failed",
				stage: "restart",
				error: `restart backboardd: ${lastLine(kick.stderr, `exit ${kick.exitCode}`)}`,
			};
		}
		return { kind: "recovered", note: "restarted backboardd" };
	} catch (error) {
		return { kind: "failed", stage, error: message(error) };
	}
}

/** How long a rebooted sim gets to finish booting (`bootstatus -b`): a warm clone is up in ~20-40 s on CI. */
export const REBOOT_READY_MS = 60_000;

/** What a reboot needs of the iOS provider: the same shutdown, boot + ready wait and post-boot steps a claim uses. */
export type RebootProvider = Pick<DeviceProvider, "shutdown" | "afterReady"> & {
	bootReady: NonNullable<DeviceProvider["bootReady"]>;
};

/** Where a reboot stopped. */
export type RebootStage = "shutdown" | "boot" | "ready";

export type AxReboot = { kind: "rebooted" } | { kind: "failed"; stage: RebootStage; error: string };

/**
 * The last resort for a wedged accessibility service that a backboardd restart did not clear: shut the simulator down,
 * boot it and wait until it is ready (`bootstatus -b`), then redo the provider's post-boot steps (a biometrics sim's
 * enrollment, which a shutdown forgets). Installed apps, the keychain and slimming (on disk) survive; running apps and
 * any helper do not: the caller stops its helper first and connects a fresh one after. The caller also decides that
 * warden may touch this sim (leased by this run). Never throws.
 */
export async function rebootSimulator(provider: RebootProvider, udid: string, readyMs: number): Promise<AxReboot> {
	let stage: RebootStage = "shutdown";
	try {
		const down = await provider.shutdown(udid);
		if (!down.success) return { kind: "failed", stage, error: down.error };
		stage = "boot";
		const up = await provider.bootReady(udid, readyMs);
		if (up.kind === "boot-failed") return { kind: "failed", stage: "boot", error: up.error };
		if (up.kind === "not-ready") return { kind: "failed", stage: "ready", error: up.error };
		stage = "ready";
		await provider.afterReady?.(udid);
		return { kind: "rebooted" };
	} catch (error) {
		return { kind: "failed", stage, error: message(error) };
	}
}
