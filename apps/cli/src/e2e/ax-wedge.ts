import type { Exec } from "@delacour/warden-core/exec";

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

/** One recovery attempt's outcome: `recovered` means backboardd (and SpringBoard with it) was restarted. */
export type AxRecovery =
	| { kind: "recovered"; note: string }
	| { kind: "not-wedged" }
	| { kind: "failed"; error: string };

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
			return { kind: "failed", error: `log show: ${lastLine(log.stderr, `exit ${log.exitCode}`)}` };
		if (!logNamesWedge(log.stdout)) return { kind: "not-wedged" };
		const kick = await exec(["xcrun", "simctl", "spawn", udid, "launchctl", "kickstart", "-k", BACKBOARDD], {
			timeoutMs: KICKSTART_TIMEOUT_MS,
		});
		if (kick.exitCode !== 0) {
			return { kind: "failed", error: `restart backboardd: ${lastLine(kick.stderr, `exit ${kick.exitCode}`)}` };
		}
		return { kind: "recovered", note: "restarted backboardd" };
	} catch (error) {
		return { kind: "failed", error: message(error) };
	}
}
