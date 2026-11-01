import type { InventoryDevice, Platform } from "@delacour/warden-store/types";
import type { WardenError } from "@delacour/warden-types/error";
import type { AsyncResult } from "@delacour/warden-types/result";
import type { DeviceProvider, ProviderDeps } from "./provider.types";

/** Identity of a device warden just made, as the store's `devices` table keeps it. */
export type CreatedDevice = { id: string; name: string; profile: string; runtime?: string | undefined };

/** The refusal verbs of {@link BaseDeviceProvider.refuse}. */
export type RefusedVerb = "boot" | "shut down";

/**
 * What the iOS and Android providers share: the {@link DeviceProvider} contract, the store record of the
 * devices a provider made, the progress notes, and the rule that a physical device is never booted or shut down.
 * Plugin providers (`defineProvider`) satisfy the {@link DeviceProvider} interface without extending this.
 */
export abstract class BaseDeviceProvider implements DeviceProvider {
	abstract readonly platform: Platform;

	constructor(protected readonly deps: ProviderDeps) {}

	abstract inventory(): AsyncResult<InventoryDevice[], WardenError>;

	abstract create(name: string, profile: string, runtime?: string): AsyncResult<InventoryDevice, WardenError>;

	abstract waitReady(id: string, timeoutMs: number): AsyncResult<void, WardenError>;

	/** Boot a device warden may boot; a physical one is refused. */
	boot(id: string): AsyncResult<void, WardenError> {
		return this.isPhysical(id) ? this.refuse("boot", id) : this.bootDevice(id);
	}

	/** Shut down a device warden may shut down; a physical one is refused. */
	shutdown(id: string): AsyncResult<void, WardenError> {
		return this.isPhysical(id) ? this.refuse("shut down", id) : this.shutdownDevice(id);
	}

	/** Is `id` a phone or other device warden leases but never boots, shuts down or creates. */
	protected abstract isPhysical(id: string): boolean;

	/** The error for `verb` on a physical device `id`. */
	protected abstract refuse(verb: RefusedVerb, id: string): AsyncResult<void, WardenError>;

	protected abstract bootDevice(id: string): AsyncResult<void, WardenError>;

	protected abstract shutdownDevice(id: string): AsyncResult<void, WardenError>;

	/** A progress note (stderr in the CLI). */
	protected note(line: string): void {
		this.deps.log?.(line);
	}

	/** The store record of a device this provider made. */
	protected recordOf(id: string) {
		return this.deps.store.listDevices(this.platform).find((d) => d.id === id);
	}

	/** Remember a device this provider just made. */
	protected remember(device: CreatedDevice): void {
		this.deps.store.recordDevice({ platform: this.platform, ...device }, this.deps.now());
	}
}
