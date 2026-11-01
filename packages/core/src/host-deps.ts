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
import { leaseConditions } from "./conditions/conditions";
import { type OrphanUndoReport, orphanConditions } from "./conditions/orphans";
import { ConditionUndo } from "./conditions/undo";
import {
	AndroidGolden,
	type AndroidGoldenDeps,
	androidSnapshotModel,
	type SnapshotPass,
} from "./golden/android-golden";
import { AndroidSnapshotPending, ciEnvironment } from "./golden/android-snapshot-pending";
import { type GoldenDeps, IosGolden } from "./golden/ios-golden";

export type Sleep = (ms: number) => Promise<void>;

/** What the golden / provider wiring reads from a host: everything of a {@link LeaseHost} except the two hooks it provides. */
export type GoldenHost = Omit<LeaseHost, "providerFor" | "stopHelper" | "hostFacts">;

/** What undoing conditions needs from a host: the {@link LeaseHost} minus the hooks wired here. */
export type ConditionsHost = Pick<LeaseHost, "env" | "exec" | "now" | "pidAlive" | "store">;

/** What a claim or gc needs to undo orphans; the clock and liveness default to the real ones. */
export type OrphanHost = {
	exec: Exec;
	env: Record<string, string | undefined>;
	now?: () => number;
	pidAlive?: PidAlive;
	kill?: (pid: number) => void;
};

/** Wires golden, snapshot, provider and condition-undo side effects to a host. */
export class HostDeps {
	/** Golden-sim side effects wired to the host. Its log lines are `golden` progress events. */
	goldenDeps(host: GoldenHost, owner: Owner, sleep: Sleep = host.sleep): GoldenDeps {
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
	goldenEnabled(env: Record<string, string | undefined>): boolean {
		return env.WARDEN_GOLDEN !== "0";
	}

	/** Android golden (quick-boot snapshot) side effects wired to the host. */
	androidGoldenDeps(host: GoldenHost, owner: Owner, sleep: Sleep = host.sleep): AndroidGoldenDeps {
		return { ...this.goldenDeps(host, owner, sleep) };
	}

	/**
	 * Android snapshots on? `WARDEN_ANDROID_SNAPSHOT` when it says on/off, else `android.snapshot` of the
	 * nearest config, else on. An unrecognised env value is warned about and left to the config.
	 */
	async androidSnapshotOn(host: Pick<GoldenHost, "cwd" | "env" | "log">): Promise<boolean> {
		const explicit = androidSnapshotModel.explicit(host.env, (value) =>
			host.log?.({
				kind: "warn",
				message: `WARDEN_ANDROID_SNAPSHOT=${value} is not one of 0/1/true/false/on/off/yes/no — using android.snapshot from the config`,
			})
		);
		return explicit ?? (await this.configuredAndroidSnapshot(host)) !== false;
	}

	/**
	 * The Android provider's `snapshot` hook: warden's quick-boot snapshot of the AVD when it exists (a
	 * claim never builds one: missing → cold boot, logged, and `warden gc` builds it later), unless
	 * `WARDEN_ANDROID_SNAPSHOT=0` or `android.snapshot: false` (looked up only when a claim creates).
	 */
	androidSnapshotHook(host: GoldenHost, owner: Owner, sleep?: Sleep): (avd: string) => AsyncResult<string | undefined> {
		return async (avd) => {
			if (!(await this.androidSnapshotOn(host))) return resultFactory.ok(undefined);
			return new AndroidGolden(this.androidGoldenDeps(host, owner, sleep)).forClaim(avd);
		};
	}

	/** The provider's `snapshotFailed` hook: drop a snapshot a claim saw fail to load, so the next build replaces it. */
	androidSnapshotFailedHook(
		host: GoldenHost,
		owner: Owner,
		sleep?: Sleep
	): (avd: string, name: string) => AsyncResult<void> {
		return (avd, name) => new AndroidGolden(this.androidGoldenDeps(host, owner, sleep)).invalidate(avd, name);
	}

	/**
	 * `warden gc`'s Android snapshot step: build the snapshot of one pending AVD with no running instance.
	 * Never under `CI`; snapshots off → the pending list is dropped. An AVD whose snapshot keeps failing to
	 * load is no longer built here, and gc's notes say so. Returns gc's notes.
	 */
	async androidSnapshotPass(
		host: GoldenHost,
		owner: Owner,
		build: (deps: AndroidGoldenDeps) => AsyncResult<SnapshotPass> = (deps) => new AndroidGolden(deps).buildPending()
	): Promise<string[]> {
		if (ciEnvironment.active(host.env)) return [];
		const givenUp = new AndroidSnapshotPending(host.store()).givenUp();
		const due = new AndroidSnapshotPending(host.store()).pending(host.now()).length > 0;
		if (!due && givenUp.length === 0) return [];
		if (!(await this.androidSnapshotOn(host))) {
			new AndroidSnapshotPending(host.store()).clear();
			return [];
		}
		const notes = givenUp.map(
			(avd) =>
				`android snapshot of ${avd} does not load on this host: gc no longer rebuilds it (warden golden ensure --platform android --profile ${leaseModel.profileSlug(avd)} does)`
		);
		if (!due) return notes;
		const pass: Result<SnapshotPass> = await build(this.androidGoldenDeps(host, owner));
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
	providerFor(
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
				snapshot: this.androidSnapshotHook(host, owner, opts.sleep),
				snapshotFailed: this.androidSnapshotFailedHook(host, owner, opts.sleep),
				snapshotLoaded: (avd) => new AndroidSnapshotPending(host.store()).loaded(avd),
			});
		const base = {
			...(opts.slim === undefined ? {} : { slim: opts.slim }),
			...(opts.physical === true ? { physical: true } : {}),
			...(opts.namedPhysical !== undefined ? { namedPhysical: opts.namedPhysical } : {}),
		};
		if (!this.goldenEnabled(host.env)) return new IosProvider(deps, base);
		const golden = { ...this.goldenDeps(host, owner, opts.sleep), prewarmHint: true };
		return new IosProvider(deps, {
			...base,
			clone: async (name, profile, runtime) => {
				const cloned = await new IosGolden(golden).cloneFrom(profile, runtime, name);
				return cloned.success
					? {
							success: true,
							data: { udid: cloned.data.udid, runtime: simctlParser.shortRuntime(cloned.data.runtimeId) },
						}
					: wardenErrors.err("failed", cloned.error);
			},
		});
	}

	/**
	 * The {@link LeaseConditions} hook for a host: `has` is a store read, `undo` resets what a lease set on its device
	 * (network, location, clock …) and stops the processes holding it, one note per failed reset; it never throws.
	 */
	leaseConditions(host: ConditionsHost): LeaseConditions {
		return {
			has: (lease) => lease.resource.kind === "device" && leaseConditions.active(host.store(), lease.id).length > 0,
			undo: async (lease) => {
				const store = host.store();
				const done = await new ConditionUndo({
					store,
					exec: host.exec,
					env: host.env,
					now: host.now,
					pidAlive: host.pidAlive,
					kill: this.killProcess,
					// imported only when a network condition is set, so release / gc stay light
					releaseProxy: async (id) =>
						new (await import("./netproxy/lease-proxy")).LeaseProxyService({
							store,
							env: host.env,
							now: host.now,
							kill: this.killProcess,
							pidAlive: host.pidAlive,
						}).release(id),
				}).undo(lease);
				return done.success ? [] : done.error.errors.map((e) => `conditions on ${lease.id}: ${e}`);
			},
		};
	}

	/** `orphanConditions.undo` wired to a host: real kill / liveness and a proxy releaser that imports its module only for a network orphan. */
	async undoOrphansWith(
		store: Store,
		host: OrphanHost,
		device: { platform: Platform; id: string }
	): Promise<OrphanUndoReport> {
		const pidAlive = host.pidAlive ?? liveness.processAlive;
		const kill = host.kill ?? this.killProcess;
		const now = host.now ?? Date.now;
		return orphanConditions.undo(
			{
				store,
				exec: host.exec,
				env: host.env,
				now,
				pidAlive,
				kill,
				releaseProxy: async (id) =>
					new (await import("./netproxy/lease-proxy")).LeaseProxyService({
						store,
						env: host.env,
						now,
						kill,
						pidAlive,
					}).release(id),
			},
			device
		);
	}

	/**
	 * The `ClaimInput.orphans` callback for a host: undoes the conditions a deleted lease left on a claimed device
	 * and returns one note per failed reset.
	 */
	orphanUndo(host: ConditionsHost): (device: InventoryDevice) => Promise<string[]> {
		return async (device) => {
			const report = await this.undoOrphansWith(
				host.store(),
				{ exec: host.exec, env: host.env, now: host.now, pidAlive: host.pidAlive },
				device
			);
			return report.errors;
		};
	}

	/**
	 * `android.snapshot` of the nearest warden config; a missing or broken config leaves the default.
	 * Loaded lazily: the config loader pulls in zod, which the claim's cold start must not.
	 */
	private async configuredAndroidSnapshot(host: Pick<GoldenHost, "cwd" | "env">): Promise<boolean | undefined> {
		const { projectConfig } = await import("@delacour/warden-builds/config");
		const found = projectConfig.find(host.cwd, this.configSearchBound(host.cwd, host.env), host.env);
		return found.success ? found.data?.config.android?.snapshot : undefined;
	}

	/** The highest directory a config search from `cwd` may reach without a git spawn: the home directory, else `cwd`. */
	private configSearchBound(cwd: string, env: Record<string, string | undefined>): string {
		const home = env.HOME;
		if (home === undefined || home === "") return resolve(cwd);
		const rel = relative(resolve(home), resolve(cwd));
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? resolve(home) : resolve(cwd);
	}

	private readonly killProcess = (pid: number): void => {
		process.kill(pid, "SIGTERM");
	};
}

export const hostDeps = new HostDeps();
