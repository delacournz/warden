import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { type Exec, execError } from "../exec";
import { disabledLabels, readDisabledStore, writeDisabledStore } from "./disabled-store";
import { parsePrintDisabled } from "./slim";
import { delta, desiredLabels, managedSet, type SlimProfile } from "./slim.profile";

/**
 * Offline slim: write the profile into the host-side launchd override store of a SHUT DOWN simulator,
 * so `launchd_sim` boots it already slimmed with no `simctl spawn` at all. Never call it for a booted
 * sim: its launchd rewrites the file itself.
 */

export type OfflineSlim = { written: number; path: string } | { written: 0; skipped: "already-slim" };

/** Overrides the store holds are honoured at boot from iOS 18.5 on. */
const MIN_MAJOR = 18;
const MIN_MINOR = 5;

/** `iOS-26-5` / `iOS 18.5` / `iOS-18-5-1` → whether the runtime reads the persisted override store. */
export function runtimeSupportsPersistentOverrides(runtimeShortName: string): boolean {
	const m = /^iOS[- ](\d+)[-.](\d+)/.exec(runtimeShortName);
	if (!m) return false;
	const major = Number(m[1]);
	const minor = Number(m[2]);
	return major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR);
}

/**
 * Bring the store to `profile`: disable wanted labels, re-enable managed ones disabled beyond it
 * (retired labels included). Writes only when the delta is non-empty.
 */
export async function prepareOfflineSlim(
	udid: string,
	profile: SlimProfile,
	opts: { root?: string } = {}
): AsyncResult<OfflineSlim> {
	const current = await readDisabledStore(udid, opts.root);
	if (!current.success) return current;
	const { toDisable, toEnable } = delta(disabledLabels(current.data), desiredLabels(profile), managedSet());
	if (toDisable.length === 0 && toEnable.length === 0) return ok({ written: 0, skipped: "already-slim" });
	const written = await writeDisabledStore(udid, { disable: toDisable, enable: toEnable }, opts.root);
	if (!written.success) return written;
	return ok({ written: toDisable.length + toEnable.length, path: written.data.path });
}

/** Waits between reads of a launchd domain that is still tearing down / timing out. */
export const VERIFY_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];

const isTransient = (res: { exitCode: number; stdout: string; stderr: string }): boolean =>
	res.exitCode === 124 || /Domain is tearing down|code=124/.test(`${res.stdout}\n${res.stderr}`);

/**
 * One `launchctl print-disabled system` in the booted sim: which desired labels are NOT disabled.
 * A transient failure (exit 124, "Domain is tearing down") is retried up to 4 times with 1/2/4/8 s.
 */
export async function verifyOfflineSlim(
	exec: Exec,
	udid: string,
	profile: SlimProfile,
	opts: { sleep?: (ms: number) => Promise<void> } = {}
): AsyncResult<{ missing: string[] }> {
	const sleep = opts.sleep ?? Bun.sleep;
	const cmd = ["xcrun", "simctl", "spawn", udid, "launchctl", "print-disabled", "system"];
	for (let attempt = 0; ; attempt++) {
		const res = await exec(cmd);
		if (res.exitCode === 0 && !isTransient(res)) {
			const disabled = parsePrintDisabled(res.stdout);
			const missing = [...desiredLabels(profile)].filter((l) => disabled.get(l) !== true).sort();
			return ok({ missing });
		}
		const wait = VERIFY_BACKOFF_MS[attempt];
		if (!isTransient(res) || wait === undefined) return err(execError(cmd, res));
		await sleep(wait);
	}
}
