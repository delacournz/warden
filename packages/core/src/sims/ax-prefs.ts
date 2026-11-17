import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { execError } from "../exec";
import { execWithin, type TimedExec } from "../providers/health";

/**
 * Accessibility preferences written into a shut-down sim before it boots, so the accessibility server reads them
 * at its first start instead of the driver flipping them live:
 * - `AutomationEnabled`: the automation the AX readers ride on (otherwise the helper's first open writes it in-sim).
 * - `IgnoreAXServerEntitlements`: the AX server stops checking the client's entitlement, so a read from a process
 *   without it is not refused. Older runtimes read it; on runtimes that never look the key up it is inert.
 */
export const PREBOOT_AX_KEYS = ["AutomationEnabled", "IgnoreAXServerEntitlements"] as const;

/** One `plutil` on a local file: quick, but bounded so a stuck call never holds the boot. */
export const AX_PREFS_WRITE_TIMEOUT_MS = 10_000;

/** `WARDEN_AX_PREFS=0` turns the pre-boot write off (an A/B run, or a runtime that misreads it). */
export function axPrefsEnabled(env: Record<string, string | undefined>): boolean {
	return env.WARDEN_AX_PREFS !== "0";
}

/** The device's Accessibility preferences, in the default device set. */
export function accessibilityPlistPath(env: Record<string, string | undefined>, udid: string): string {
	return join(
		env.HOME ?? "~",
		"Library/Developer/CoreSimulator/Devices",
		udid,
		"data/Library/Preferences/com.apple.Accessibility.plist"
	);
}

async function plutil(deps: TimedExec, cmd: string[]): AsyncResult<void> {
	const out = await execWithin(deps, cmd, AX_PREFS_WRITE_TIMEOUT_MS);
	if (out === undefined) return err(`\`${cmd.join(" ")}\` did not finish within ${AX_PREFS_WRITE_TIMEOUT_MS / 1000}s`);
	return out.exitCode === 0 ? ok(undefined) : err(execError(cmd, out));
}

/**
 * Write every `PREBOOT_AX_KEYS` key as `true` on the host, with the sim shut down (no cfprefsd running, so a file
 * write persists). Existing keys are kept; only a plist missing on disk is created, so a failed write on an existing
 * one is returned, never answered by replacing it with an empty plist. A device that has never booted has no
 * `Preferences` dir yet: it is left alone (`not-booted-yet`), since creating the data dir early can upset its first
 * boot's setup, and the helper still turns automation on live.
 */
export async function writePrebootAxPrefs(
	deps: TimedExec,
	env: Record<string, string | undefined>,
	udid: string
): AsyncResult<"written" | "not-booted-yet"> {
	const plist = accessibilityPlistPath(env, udid);
	if (!existsSync(dirname(plist))) return ok("not-booted-yet");
	if (!existsSync(plist)) {
		const created = await plutil(deps, ["plutil", "-create", "binary1", plist]);
		if (!created.success) return created;
	}
	for (const key of PREBOOT_AX_KEYS) {
		const written = await plutil(deps, ["plutil", "-replace", key, "-bool", "true", plist]);
		if (!written.success) return written;
	}
	return ok("written");
}
