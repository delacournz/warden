import {
	type AndroidGoldenDeps,
	androidSnapshotEnabled,
	ensureAndroidSnapshot,
} from "@delacour/warden-core/golden/android-golden";
import type { GoldenDeps } from "@delacour/warden-core/golden/ios-golden";
import { processAlive } from "@delacour/warden-core/liveness";
import type { Owner } from "@delacour/warden-core/types";
import { type AsyncResult, ok } from "@delacour/warden-types/result";
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
 * The Android provider's `snapshot` hook: warden's quick-boot snapshot of the AVD, built on first use,
 * unless `WARDEN_ANDROID_SNAPSHOT=0` or `android.snapshot: false` (looked up only when a claim creates).
 */
export function androidSnapshotHook(
	ctx: CommandContext,
	owner: Owner,
	sleep?: Sleep
): (avd: string) => AsyncResult<string | undefined> {
	return async (avd) => {
		const explicit = ctx.env.WARDEN_ANDROID_SNAPSHOT !== undefined && ctx.env.WARDEN_ANDROID_SNAPSHOT.trim() !== "";
		if (!androidSnapshotEnabled(ctx.env, explicit ? undefined : await configuredAndroidSnapshot(ctx)))
			return ok(undefined);
		const ensured = await ensureAndroidSnapshot({ ...androidGoldenDeps(ctx, owner, sleep), prewarmHint: true }, avd);
		return ensured.success ? ok(ensured.data?.name) : ensured;
	};
}
