import {
	AndroidGolden,
	type AndroidGoldenDeps,
	androidSnapshotModel,
	type SnapshotPass,
} from "@delacour/warden-core/golden/android-golden";
import { AndroidSnapshotPending, ciEnvironment } from "@delacour/warden-core/golden/android-snapshot-pending";
import type { GoldenDeps } from "@delacour/warden-core/golden/ios-golden";
import { biometricProfiles } from "@delacour/warden-providers/biometrics";
import { liveness } from "@delacour/warden-store/liveness";
import { leaseModel, type Owner } from "@delacour/warden-store/types";
import { type AsyncResult, type Result, resultFactory } from "@delacour/warden-types/result";
import type { CommandContext } from "./context";

export type Sleep = (ms: number) => Promise<void>;

export class GoldenDepsHelpers {
	/** Golden-sim side effects wired to the command context. */
	goldenDeps(ctx: CommandContext, owner: Owner, sleep: Sleep = Bun.sleep): GoldenDeps {
		return {
			exec: ctx.exec,
			store: ctx.store(),
			owner,
			pid: process.pid,
			env: ctx.env,
			now: ctx.now,
			pidAlive: liveness.processAlive,
			sleep,
			log: (line) => ctx.err(`warden ${line}`),
		};
	}

	/** Cloning from goldens is on unless `WARDEN_GOLDEN=0`. */
	goldenEnabled(env: Record<string, string | undefined>): boolean {
		return env.WARDEN_GOLDEN !== "0";
	}

	/** Android golden (quick-boot snapshot) side effects wired to the command context. */
	androidGoldenDeps(ctx: CommandContext, owner: Owner, sleep: Sleep = Bun.sleep): AndroidGoldenDeps {
		return { ...this.goldenDeps(ctx, owner, sleep) };
	}

	/**
	 * `android.snapshot` of the nearest warden config; a missing or broken config leaves the default.
	 * Loaded lazily: the config loader pulls in zod, which the claim's cold start must not.
	 */
	private async configuredAndroidSnapshot(ctx: CommandContext): Promise<boolean | undefined> {
		const { projectConfig } = await import("@delacour/warden-builds/config");
		const found = projectConfig.find(ctx.cwd, undefined, ctx.env);
		return found.success ? found.data?.config.android?.snapshot : undefined;
	}

	/**
	 * Android snapshots on? `WARDEN_ANDROID_SNAPSHOT` when it says on/off, else `android.snapshot` of the
	 * nearest config, else on. An unrecognised env value is warned about and left to the config.
	 */
	async androidSnapshotOn(ctx: CommandContext): Promise<boolean> {
		const explicit = androidSnapshotModel.explicit(ctx.env, (value) =>
			ctx.err(
				`warden: WARDEN_ANDROID_SNAPSHOT=${value} is not one of 0/1/true/false/on/off/yes/no — using android.snapshot from the config`
			)
		);
		return explicit ?? (await this.configuredAndroidSnapshot(ctx)) !== false;
	}

	/**
	 * The Android provider's `snapshot` hook: warden's quick-boot snapshot of the AVD when it exists (a
	 * claim never builds one: missing → cold boot, logged, and `warden gc` builds it later), unless
	 * `WARDEN_ANDROID_SNAPSHOT=0` or `android.snapshot: false` (looked up only when a claim creates). A biometrics
	 * target (`<avd>+bio`) is built right here when missing, since an unenrolled cold boot would be wrong for it.
	 */
	androidSnapshotHook(
		ctx: CommandContext,
		owner: Owner,
		sleep?: Sleep
	): (avd: string) => AsyncResult<string | undefined> {
		return async (avd) => {
			if (!(await this.androidSnapshotOn(ctx))) return resultFactory.ok(undefined);
			const deps = this.androidGoldenDeps(ctx, owner, sleep);
			if (!biometricProfiles.split(avd).biometrics) return new AndroidGolden(deps).forClaim(avd);
			// a biometrics claim must start enrolled: build the snapshot now (once, under the AVD's lock) rather than cold-boot plain
			const ensured = await new AndroidGolden({ ...deps, prewarmHint: true }).ensure(avd);
			return ensured.success ? resultFactory.ok(ensured.data?.name) : ensured;
		};
	}

	/** The provider's `snapshotFailed` hook: drop a snapshot a claim saw fail to load, so the next build replaces it. */
	androidSnapshotFailedHook(
		ctx: CommandContext,
		owner: Owner,
		sleep?: Sleep
	): (avd: string, name: string) => AsyncResult<void> {
		return (avd, name) => new AndroidGolden(this.androidGoldenDeps(ctx, owner, sleep)).invalidate(avd, name);
	}

	/**
	 * `warden gc`'s Android snapshot step: build the snapshot of one pending AVD with no running instance.
	 * Never under `CI`; snapshots off → the pending list is dropped. An AVD whose snapshot keeps failing to
	 * load is no longer built here, and gc's notes say so. Returns gc's notes.
	 */
	async androidSnapshotPass(
		ctx: CommandContext,
		owner: Owner,
		build: (deps: AndroidGoldenDeps) => AsyncResult<SnapshotPass> = (deps) => new AndroidGolden(deps).buildPending()
	): Promise<string[]> {
		if (ciEnvironment.active(ctx.env)) return [];
		const givenUp = new AndroidSnapshotPending(ctx.store()).givenUp();
		const due = new AndroidSnapshotPending(ctx.store()).pending(ctx.now()).length > 0;
		if (!due && givenUp.length === 0) return [];
		if (!(await this.androidSnapshotOn(ctx))) {
			new AndroidSnapshotPending(ctx.store()).clear();
			return [];
		}
		const notes = givenUp.map(
			(avd) =>
				`android snapshot of ${avd} does not load on this host: gc no longer rebuilds it (warden golden ensure --platform android --profile ${leaseModel.profileSlug(avd)} does)`
		);
		if (!due) return notes;
		const pass: Result<SnapshotPass> = await build(this.androidGoldenDeps(ctx, owner));
		if (!pass.success) return [...notes, `android snapshot: ${pass.error}`];
		if (pass.data.built) notes.push(`built android snapshot ${pass.data.built.name} of ${pass.data.built.avd}`);
		if (pass.data.failed) notes.push(`android snapshot of ${pass.data.failed.avd} failed: ${pass.data.failed.error}`);
		if (pass.data.busy.length > 0)
			notes.push(`android snapshot of ${pass.data.busy.join(", ")} waits until no emulator of it runs`);
		return notes;
	}
}

export const goldenDepsHelpers = new GoldenDepsHelpers();
