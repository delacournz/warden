import type { AsyncResult } from "@delacour/warden-types/result";
import type { Exec } from "../exec";
import type { Store } from "../store";
import type { InventoryDevice, Owner, Platform } from "../types";

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
}

export type ProviderDeps = {
	exec: Exec;
	store: Store;
	env: Record<string, string | undefined>;
	now: () => number;
	/** the claimer — owner for any side leases a provider takes (e.g. Android console ports) */
	owner: Owner;
	/** progress notes (e.g. "cloning from golden…") — stderr in the CLI */
	log?: (line: string) => void;
};
