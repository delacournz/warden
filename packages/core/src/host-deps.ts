import { isAbsolute, relative, resolve } from "node:path";
import type { LeaseConditions, LeaseHost, ProviderOptions } from "@delacour/warden-leasing/lease-host";
import { AndroidProvider } from "@delacour/warden-providers/android";
import { IosProvider, simctlParser } from "@delacour/warden-providers/ios";
import type { DeviceProvider, ProviderDeps } from "@delacour/warden-providers/provider.types";
import type { Exec } from "@delacour/warden-runtime/exec";
import { liveness, type PidAlive } from "@delacour/warden-store/liveness";
import type { Store } from "@delacour/warden-store/store";
import type { InventoryDevice, Owner, Platform } from "@delacour/warden-store/types";
import { leaseModel } from "@delacour/warden-store/types";
import { wardenErrors } from "@delacour/warden-types/error";
import { type AsyncResult, type Result, resultFactory } from "@delacour/warden-types/result";
import { activeConditions } from "./conditions/conditions";
import { type OrphanUndoReport, undoOrphans } from "./conditions/orphans";
import { undoConditions } from "./conditions/undo";
import {
	type AndroidGoldenDeps,
	buildPendingAndroidSnapshot,
	explicitAndroidSnapshot,
	invalidateAndroidSnapshot,
	type SnapshotPass,
	snapshotForClaim,
} from "./golden/android-golden";
import {
	androidSnapshotLoaded,
	androidSnapshotsGivenUp,
	clearAndroidSnapshotPending,
	onCi,
	pendingAndroidSnapshots,
} from "./golden/android-snapshot-pending";
import { cloneFromGolden, type GoldenDeps } from "./golden/ios-golden";

export type Sleep = (ms: number) => Promise<void>;

/** What the golden / provider wiring reads from a host: everything of a {@link LeaseHost} except the two hooks it provides. */
export type GoldenHost = Omit<LeaseHost, "providerFor" | "stopHelper" | "hostFacts">;

/** Golden-sim side effects wired to the host. Its log lines are `golden` progress events. */
export function goldenDeps(host: GoldenHost, owner: Owner, sleep: Sleep = host.sleep): GoldenDeps {
	return {
		exec: host.exec,
		store: host.store(),
		owner,
		pid: process.pid,
		env: host.env,
		now: host.now,
		pidAlive: host.pidAlive,
		sleep,
		log: (line) => host.log?.({ kind: "progress", phase: "golden", message: line }),
	};
}

/** Cloning from goldens is on unless `WARDEN_GOLDEN=0`. */
export function goldenEnabled(env: Record<string, string | undefined>): boolean {
	return env.WARDEN_GOLDEN !== "0";
}

/** Android golden (quick-boot snapshot) side effects wired to the host. */
export function androidGoldenDeps(host: GoldenHost, owner: Owner, sleep: Sleep = host.sleep): AndroidGoldenDeps {
	return { ...goldenDeps(host, owner, sleep) };
}

/**
 * `android.snapshot` of the nearest warden config; a missing or broken config leaves the default.
 * Loaded lazily: the config loader pulls in zod, which the claim's cold start must not.
 */
async function configuredAndroidSnapshot(host: Pick<GoldenHost, "cwd" | "env">): Promise<boolean | undefined> {
	const { projectConfig } = await import("@delacour/warden-builds/config");
	const found = projectConfig.find(host.cwd, configSearchBound(host.cwd, host.env), host.env);
	return found.success ? found.data?.config.android?.snapshot : undefined;
}

/** The highest directory a config search from `cwd` may reach without a git spawn: the home directory, else `cwd`. */
function configSearchBound(cwd: string, env: Record<string, string | undefined>): string {
	const home = env.HOME;
	if (home === undefined || home === "") return resolve(cwd);
	const rel = relative(resolve(home), resolve(cwd));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? resolve(home) : resolve(cwd);
}

/**
 * Android snapshots on? `WARDEN_ANDROID_SNAPSHOT` when it says on/off, else `android.snapshot` of the
 * nearest config, else on. An unrecognised env value is warned about and left to the config.
 */
export async function androidSnapshotOn(host: Pick<GoldenHost, "cwd" | "env" | "log">): Promise<boolean> {
	const explicit = explicitAndroidSnapshot(host.env, (value) =>
		host.log?.({
			kind: "warn",
			message: `WARDEN_ANDROID_SNAPSHOT=${value} is not one of 0/1/true/false/on/off/yes/no — using android.snapshot from the config`,
		})
	);
	return explicit ?? (await configuredAndroidSnapshot(host)) !== false;
}

/**
 * The Android provider's `snapshot` hook: warden's quick-boot snapshot of the AVD when it exists (a
 * claim never builds one: missing → cold boot, logged, and `warden gc` builds it later), unless
 * `WARDEN_ANDROID_SNAPSHOT=0` or `android.snapshot: false` (looked up only when a claim creates).
 */
export function androidSnapshotHook(
	host: GoldenHost,
	owner: Owner,
	sleep?: Sleep
): (avd: string) => AsyncResult<string | undefined> {
	return async (avd) => {
		if (!(await androidSnapshotOn(host))) return resultFactory.ok(undefined);
		return snapshotForClaim(androidGoldenDeps(host, owner, sleep), avd);
	};
}

/** The provider's `snapshotFailed` hook: drop a snapshot a claim saw fail to load, so the next build replaces it. */
export function androidSnapshotFailedHook(
	host: GoldenHost,
	owner: Owner,
	sleep?: Sleep
): (avd: string, name: string) => AsyncResult<void> {
	return (avd, name) => invalidateAndroidSnapshot(androidGoldenDeps(host, owner, sleep), avd, name);
}

/**
 * `warden gc`'s Android snapshot step: build the snapshot of one pending AVD with no running instance.
 * Never under `CI`; snapshots off → the pending list is dropped. An AVD whose snapshot keeps failing to
 * load is no longer built here, and gc's notes say so. Returns gc's notes.
 */
export async function androidSnapshotPass(
	host: GoldenHost,
	owner: Owner,
	build: (deps: AndroidGoldenDeps) => AsyncResult<SnapshotPass> = buildPendingAndroidSnapshot
): Promise<string[]> {
	if (onCi(host.env)) return [];
	const givenUp = androidSnapshotsGivenUp(host.store());
	const due = pendingAndroidSnapshots(host.store(), host.now()).length > 0;
	if (!due && givenUp.length === 0) return [];
	if (!(await androidSnapshotOn(host))) {
		clearAndroidSnapshotPending(host.store());
		return [];
	}
	const notes = givenUp.map(
		(avd) =>
			`android snapshot of ${avd} does not load on this host: gc no longer rebuilds it (warden golden ensure --platform android --profile ${leaseModel.profileSlug(avd)} does)`
	);
	if (!due) return notes;
	const pass: Result<SnapshotPass> = await build(androidGoldenDeps(host, owner));
	if (!pass.success) return [...notes, `android snapshot: ${pass.error}`];
	if (pass.data.built) notes.push(`built android snapshot ${pass.data.built.name} of ${pass.data.built.avd}`);
	if (pass.data.failed) notes.push(`android snapshot of ${pass.data.failed.avd} failed: ${pass.data.failed.error}`);
	if (pass.data.busy.length > 0)
		notes.push(`android snapshot of ${pass.data.busy.join(", ")} waits until no emulator of it runs`);
	return notes;
}

/**
 * Device provider for `platform`. iOS pool devices are cloned from a golden image (a first-booted,
 * settled sim) unless `WARDEN_GOLDEN=0`; a failed clone falls back to `simctl create`. Android emulators
 * launch from warden's quick-boot snapshot of the AVD when one exists, unless `WARDEN_ANDROID_SNAPSHOT=0` /
 * `android.snapshot: false`; a failed launch from it falls back to a cold boot. Claims never build it
 * (`warden gc` / `warden golden ensure --platform android` do).
 */
export function providerFor(
	platform: Platform,
	host: GoldenHost,
	owner: Owner,
	opts: ProviderOptions & { sleep?: Sleep } = {}
): DeviceProvider {
	const deps: ProviderDeps = {
		exec: host.exec,
		store: host.store(),
		env: host.env,
		now: host.now,
		owner,
		log: (line) => host.log?.({ kind: "progress", phase: "provider", message: line }),
	};
	if (platform === "android")
		return new AndroidProvider(deps, {
			snapshot: androidSnapshotHook(host, owner, opts.sleep),
			snapshotFailed: androidSnapshotFailedHook(host, owner, opts.sleep),
			snapshotLoaded: (avd) => androidSnapshotLoaded(host.store(), avd),
		});
	const base = {
		...(opts.slim === undefined ? {} : { slim: opts.slim }),
		...(opts.physical === true ? { physical: true } : {}),
		...(opts.namedPhysical !== undefined ? { namedPhysical: opts.namedPhysical } : {}),
	};
	if (!goldenEnabled(host.env)) return new IosProvider(deps, base);
	const golden = { ...goldenDeps(host, owner, opts.sleep), prewarmHint: true };
	return new IosProvider(deps, {
		...base,
		clone: async (name, profile, runtime) => {
			const cloned = await cloneFromGolden(golden, profile, runtime, name);
			return cloned.success
				? { success: true, data: { udid: cloned.data.udid, runtime: simctlParser.shortRuntime(cloned.data.runtimeId) } }
				: wardenErrors.err("failed", cloned.error);
		},
	});
}

/** What undoing conditions needs from a host: the {@link LeaseHost} minus the hooks wired here. */
export type ConditionsHost = Pick<LeaseHost, "env" | "exec" | "now" | "pidAlive" | "store">;

function killProcess(pid: number): void {
	process.kill(pid, "SIGTERM");
}

/**
 * The {@link LeaseConditions} hook for a host: `has` is a store read, `undo` resets what a lease set on its device
 * (network, location, clock …) and stops the processes holding it, one note per failed reset; it never throws.
 */
export function leaseConditions(host: ConditionsHost): LeaseConditions {
	return {
		has: (lease) => lease.resource.kind === "device" && activeConditions(host.store(), lease.id).length > 0,
		undo: async (lease) => {
			const store = host.store();
			const done = await undoConditions(
				{
					store,
					exec: host.exec,
					env: host.env,
					now: host.now,
					pidAlive: host.pidAlive,
					kill: killProcess,
					// imported only when a network condition is set, so release / gc stay light
					releaseProxy: async (id) =>
						(await import("./netproxy/lease-proxy")).releaseLeaseProxy(
							{ store, env: host.env, kill: killProcess, pidAlive: host.pidAlive },
							id
						),
				},
				lease
			);
			return done.success ? [] : done.error.errors.map((e) => `conditions on ${lease.id}: ${e}`);
		},
	};
}

/** What a claim or gc needs to undo orphans; the clock and liveness default to the real ones. */
export type OrphanHost = {
	exec: Exec;
	env: Record<string, string | undefined>;
	now?: () => number;
	pidAlive?: PidAlive;
	kill?: (pid: number) => void;
};

/** `undoOrphans` wired to a host: real kill / liveness and a proxy releaser that imports its module only for a network orphan. */
export async function undoOrphansWith(
	store: Store,
	host: OrphanHost,
	device: { platform: Platform; id: string }
): Promise<OrphanUndoReport> {
	const pidAlive = host.pidAlive ?? liveness.processAlive;
	const kill = host.kill ?? killProcess;
	return undoOrphans(
		{
			store,
			exec: host.exec,
			env: host.env,
			now: host.now ?? Date.now,
			pidAlive,
			kill,
			releaseProxy: async (id) =>
				(await import("./netproxy/lease-proxy")).releaseLeaseProxy({ store, env: host.env, kill, pidAlive }, id),
		},
		device
	);
}

/**
 * The `ClaimInput.orphans` callback for a host: undoes the conditions a deleted lease left on a claimed device
 * and returns one note per failed reset.
 */
export function orphanUndo(host: ConditionsHost): (device: InventoryDevice) => Promise<string[]> {
	return async (device) => {
		const report = await undoOrphansWith(
			host.store(),
			{ exec: host.exec, env: host.env, now: host.now, pidAlive: host.pidAlive },
			device
		);
		return report.errors;
	};
}
