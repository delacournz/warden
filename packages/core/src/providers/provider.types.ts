import type { AsyncResult } from "@delacour/warden-types/result";
import type { Exec } from "../exec";
import type { Store } from "../store";
import type { InventoryDevice, Owner, Platform } from "../types";
import type { Timer } from "./health";

/**
 * A device backend (iOS simulators, Android emulators). Providers report raw devices with
 * `wardenCreated: false`; callers mark warden's own via `markWardenDevices` (store `devices` table).
 * Providers never decide ownership — they only list, create, boot, wait and shut down.
 */
export interface DeviceProvider {
	readonly platform: Platform;
	inventory(): AsyncResult<InventoryDevice[]>;
	/** Create (iOS) or launch (Android) a new warden device called `name`. Returned device is not necessarily ready. */
	create(name: string, profile: string, runtime?: string): AsyncResult<InventoryDevice>;
	boot(id: string): AsyncResult<void>;
	waitReady(id: string, timeoutMs: number): AsyncResult<void>;
	shutdown(id: string): AsyncResult<void>;
	/** Is a booted device responsive? Absent = no probe (Android), treated as healthy. */
	probe?(id: string): AsyncResult<void>;
	/**
	 * Cheap proof that a device already Booted when claimed is usable: when it succeeds the claim skips
	 * `waitReady` and `probe`. A failure is not a verdict — the claim falls back to `waitReady` + `probe`.
	 * Absent = always take the full path.
	 */
	verifyWarm?(id: string): AsyncResult<void>;
	/**
	 * Boot a shut-down device and wait until it is ready in one step, where the platform can do both at
	 * once (iOS: `bootstatus -b` boots it). Absent = `boot`, then `waitReady`.
	 */
	bootReady?(id: string, timeoutMs: number): Promise<BootReady>;
	/** Probe for a device `bootReady` just booted and saw ready. Absent = `probe`. */
	probeBooted?(id: string): AsyncResult<void>;
	/**
	 * Best effort, called for a device this claim is about to boot from shutdown (after a create, or a
	 * shutdown reuse), never for an already-booted one. A failure is logged by the provider, never fatal.
	 */
	prepareBoot?(id: string): Promise<void>;
	/** Called once the device is ready, before the health probe. Best effort. */
	afterReady?(id: string): Promise<void>;
}

/** `bootReady`: a boot failure is an error; a device that booted but never got ready is unhealthy. */
export type BootReady =
	| { kind: "ready" }
	| { kind: "boot-failed"; error: string }
	| { kind: "not-ready"; error: string };

export type ProviderDeps = {
	exec: Exec;
	store: Store;
	env: Record<string, string | undefined>;
	now: () => number;
	/** the claimer — owner for any side leases a provider takes (e.g. Android console ports) */
	owner: Owner;
	/** timer for probe timeouts (default: real timers) */
	timer?: (ms: number) => Timer;
	/** progress notes (e.g. "cloning from golden…") — stderr in the CLI */
	log?: (line: string) => void;
};
