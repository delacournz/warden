import { type SlimProfile, slimProfiles } from "@delacour/warden-config/slim.profile";
import { type Exec, execErrors } from "@delacour/warden-runtime/exec";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
import { DisabledStore, disabledStoreCodec } from "./disabled-store";
import { slimPlanner } from "./slim";

/**
 * Offline slim: write the profile into the host-side launchd override store of a SHUT DOWN simulator,
 * so `launchd_sim` boots it already slimmed with no `simctl spawn` at all. Never call it for a booted
 * sim: its launchd rewrites the file itself.
 */

export type OfflineSlim = { written: number; path: string } | { written: 0; skipped: "already-slim" };

/** Overrides the store holds are honoured at boot from iOS 18.5 on. */
const MIN_MAJOR = 18;
const MIN_MINOR = 5;

/** Waits between reads of a launchd domain that is still tearing down / timing out. */
export const VERIFY_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];

/** Writes the slim profile into a shut-down simulator's host-side override store. */
export class OfflineSlimPrep {
	/** `iOS-26-5` / `iOS 18.5` / `iOS-18-5-1` → whether the runtime reads the persisted override store. */
	supportsPersistentOverrides(runtimeShortName: string): boolean {
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
	async prepare(udid: string, profile: SlimProfile, opts: { root?: string } = {}): AsyncResult<OfflineSlim> {
		const store = new DisabledStore(opts.root);
		const current = await store.read(udid);
		if (!current.success) return current;
		const { toDisable, toEnable } = slimProfiles.delta(
			disabledStoreCodec.labels(current.data),
			slimProfiles.desiredLabels(profile),
			slimProfiles.managedSet()
		);
		if (toDisable.length === 0 && toEnable.length === 0)
			return resultFactory.ok({ written: 0, skipped: "already-slim" });
		const written = await store.write(udid, { disable: toDisable, enable: toEnable });
		if (!written.success) return written;
		return resultFactory.ok({ written: toDisable.length + toEnable.length, path: written.data.path });
	}
}

export const offlineSlimPrep = new OfflineSlimPrep();

/** Reads back a booted simulator's overrides after an offline slim. */
export class OfflineSlimVerifier {
	constructor(private readonly exec: Exec) {}

	/**
	 * One `launchctl print-disabled system` in the booted sim: which desired labels are NOT disabled.
	 * A transient failure (exit 124, "Domain is tearing down") is retried up to 4 times with 1/2/4/8 s.
	 */
	async verify(
		udid: string,
		profile: SlimProfile,
		opts: { sleep?: (ms: number) => Promise<void> } = {}
	): AsyncResult<{ missing: string[] }> {
		const sleep = opts.sleep ?? Bun.sleep;
		const cmd = ["xcrun", "simctl", "spawn", udid, "launchctl", "print-disabled", "system"];
		for (let attempt = 0; ; attempt++) {
			const res = await this.exec(cmd);
			if (res.exitCode === 0 && !this.isTransient(res)) {
				const disabled = slimPlanner.parsePrintDisabled(res.stdout);
				const missing = [...slimProfiles.desiredLabels(profile)].filter((l) => disabled.get(l) !== true).sort();
				return resultFactory.ok({ missing });
			}
			const wait = VERIFY_BACKOFF_MS[attempt];
			if (!this.isTransient(res) || wait === undefined) return resultFactory.err(execErrors.format(cmd, res));
			await sleep(wait);
		}
	}

	private isTransient(res: { exitCode: number; stdout: string; stderr: string }): boolean {
		return res.exitCode === 124 || /Domain is tearing down|code=124/.test(`${res.stdout}\n${res.stderr}`);
	}
}
