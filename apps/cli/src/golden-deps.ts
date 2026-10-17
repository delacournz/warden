import { profileSlug } from "@delacour/warden-core/allocate";
import {
	type AndroidGoldenDeps,
	buildPendingAndroidSnapshot,
	explicitAndroidSnapshot,
	invalidateAndroidSnapshot,
	type SnapshotPass,
	snapshotForClaim,
} from "@delacour/warden-core/golden/android-golden";
import {
	androidSnapshotsGivenUp,
	clearAndroidSnapshotPending,
	onCi,
	pendingAndroidSnapshots,
} from "@delacour/warden-core/golden/android-snapshot-pending";
import type { GoldenDeps } from "@delacour/warden-core/golden/ios-golden";
import { processAlive } from "@delacour/warden-core/liveness";
import type { Owner } from "@delacour/warden-core/types";
import { type AsyncResult, ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "./context";

export type Sleep = (ms: number) => Promise<void>;

/** Golden-sim side effects wired to the command context. */
export function goldenDeps(ctx: CommandContext, owner: Owner, sleep: Sleep = Bun.sleep): GoldenDeps {
	return {
		exec: ctx.exec,
		store: ctx.store(),
		owner,
		pid: process.pid,
		env: ctx.env,
		now: ctx.now,
		pidAlive: processAlive,
		sleep,
		log: (line) => ctx.err(`warden ${line}`),
	};
}

/** Cloning from goldens is on unless `WARDEN_GOLDEN=0`. */
export function goldenEnabled(env: Record<string, string | undefined>): boolean {
	return env.WARDEN_GOLDEN !== "0";
}

/** Android golden (quick-boot snapshot) side effects wired to the command context. */
export function androidGoldenDeps(ctx: CommandContext, owner: Owner, sleep: Sleep = Bun.sleep): AndroidGoldenDeps {
	return { ...goldenDeps(ctx, owner, sleep) };
}

/**
 * `android.snapshot` of the nearest warden config; a missing or broken config leaves the default.
 * Loaded lazily: the config loader pulls in zod, which the claim's cold start must not.
 */
async function configuredAndroidSnapshot(ctx: CommandContext): Promise<boolean | undefined> {
	const { findWardenConfig } = await import("@delacour/warden-core/builds/config");
	const found = findWardenConfig(ctx.cwd, undefined, ctx.env);
	return found.success ? found.data?.config.android?.snapshot : undefined;
}

/**
 * Android snapshots on? `WARDEN_ANDROID_SNAPSHOT` when it says on/off, else `android.snapshot` of the
 * nearest config, else on. An unrecognised env value is warned about and left to the config.
 */
export async function androidSnapshotOn(ctx: CommandContext): Promise<boolean> {
	const explicit = explicitAndroidSnapshot(ctx.env, (value) =>
		ctx.err(
			`warden: WARDEN_ANDROID_SNAPSHOT=${value} is not one of 0/1/true/false/on/off/yes/no — using android.snapshot from the config`
		)
	);
	return explicit ?? (await configuredAndroidSnapshot(ctx)) !== false;
}

/**
 * The Android provider's `snapshot` hook: warden's quick-boot snapshot of the AVD when it exists (a
 * claim never builds one: missing → cold boot, logged, and `warden gc` builds it later), unless
 * `WARDEN_ANDROID_SNAPSHOT=0` or `android.snapshot: false` (looked up only when a claim creates).
 */
export function androidSnapshotHook(
	ctx: CommandContext,
	owner: Owner,
	sleep?: Sleep
): (avd: string) => AsyncResult<string | undefined> {
	return async (avd) => {
		if (!(await androidSnapshotOn(ctx))) return ok(undefined);
		return snapshotForClaim(androidGoldenDeps(ctx, owner, sleep), avd);
	};
}

/** The provider's `snapshotFailed` hook: drop a snapshot a claim saw fail to load, so the next build replaces it. */
export function androidSnapshotFailedHook(
	ctx: CommandContext,
	owner: Owner,
	sleep?: Sleep
): (avd: string, name: string) => AsyncResult<void> {
	return (avd, name) => invalidateAndroidSnapshot(androidGoldenDeps(ctx, owner, sleep), avd, name);
}

/**
 * `warden gc`'s Android snapshot step: build the snapshot of one pending AVD with no running instance.
 * Never under `CI`; snapshots off → the pending list is dropped. An AVD whose snapshot keeps failing to
 * load is no longer built here, and gc's notes say so. Returns gc's notes.
 */
export async function androidSnapshotPass(
	ctx: CommandContext,
	owner: Owner,
	build: (deps: AndroidGoldenDeps) => AsyncResult<SnapshotPass> = buildPendingAndroidSnapshot
): Promise<string[]> {
	if (onCi(ctx.env)) return [];
	const givenUp = androidSnapshotsGivenUp(ctx.store());
	const due = pendingAndroidSnapshots(ctx.store(), ctx.now()).length > 0;
	if (!due && givenUp.length === 0) return [];
	if (!(await androidSnapshotOn(ctx))) {
		clearAndroidSnapshotPending(ctx.store());
		return [];
	}
	const notes = givenUp.map(
		(avd) =>
			`android snapshot of ${avd} does not load on this host: gc no longer rebuilds it (warden golden ensure --platform android --profile ${profileSlug(avd)} does)`
	);
	if (!due) return notes;
	const pass: Result<SnapshotPass> = await build(androidGoldenDeps(ctx, owner));
	if (!pass.success) return [...notes, `android snapshot: ${pass.error}`];
	if (pass.data.built) notes.push(`built android snapshot ${pass.data.built.name} of ${pass.data.built.avd}`);
	if (pass.data.failed) notes.push(`android snapshot of ${pass.data.failed.avd} failed: ${pass.data.failed.error}`);
	if (pass.data.busy.length > 0)
		notes.push(`android snapshot of ${pass.data.busy.join(", ")} waits until no emulator of it runs`);
	return notes;
}
