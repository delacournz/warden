import type { AppHost } from "@delacour/warden-builds/prepare";
import type { SlimProfile } from "@delacour/warden-config/slim.profile";
import type { DeviceProvider } from "@delacour/warden-providers/provider.types";
import type { InventoryDevice, Lease, Owner, Platform } from "@delacour/warden-store/types";
import type { HostFacts } from "./host";

/**
 * Device conditions (network, location, clock …) a lease set on its device. The conditions engine sits above
 * leasing, so the embedder wires it in: `has` is a cheap store read, `undo` resets the device and stops the
 * processes holding it (while the lease is still held) and returns one note per failed reset; it never throws.
 */
export type LeaseConditions = {
	has: (lease: Lease) => boolean;
	undo: (lease: Lease) => Promise<string[]>;
};

/** What a claim asks of an iOS provider: the slim profile for sims it boots and whether to list / name physical phones. */
export type ProviderOptions = {
	slim?: SlimProfile | false;
	physical?: boolean;
	namedPhysical?: readonly string[];
};

/**
 * What the lease engine needs from the outside world: the {@link AppHost} (a `WardenHost` plus the shared
 * store and git-facts memo) and the two things that depend on packages above leasing. Progress goes out as
 * `host.log` events; the embedding application renders them.
 */
export type LeaseHost = AppHost & {
	/** RAM + cores the capacity budget is sized from; unset = read the host (`readHostFacts`) */
	hostFacts?: () => Promise<HostFacts>;
	/**
	 * The device provider for `platform`. Wired by the embedder (golden images and Android snapshots live
	 * in warden-core, which sits above leasing: `providerFor` in `@delacour/warden-core/host-deps`).
	 */
	providerFor: (platform: Platform, owner: Owner, opts?: ProviderOptions) => DeviceProvider;
	/** Stop whatever is bound to a device's old boot (a resident `warden-simd`) after it was shut down. */
	stopHelper: (udid: string) => Promise<void>;
	/** Undoes a lease's device conditions before it is released or its device shut down; unset = no conditions are tracked. */
	conditions?: LeaseConditions;
	/** Undoes the conditions a deleted lease left on a freshly claimed device; returns one note per failed reset. Unset = left for gc. */
	orphans?: (device: InventoryDevice) => Promise<string[]>;
};
