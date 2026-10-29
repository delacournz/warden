export type Platform = "ios" | "android";

/** Facts about a real phone/tablet, from its provider. Only physical devices carry one. */
export type PhysicalInfo =
	| { platform: "android"; transport: "usb" | "wifi"; adbState: string; hwSerial?: string; model?: string }
	| {
			platform: "ios";
			transport: "wired" | "localNetwork";
			deviceType: string;
			osVersion: string;
			developerMode: boolean;
			ddi: boolean;
			tunnelIp?: string;
	  };

export type DeviceResource = {
	kind: "device";
	platform: Platform;
	id: string;
	name: string;
	/** set on leases of real devices; id stays the transport id (adb serial / CoreDevice UDID) */
	physical?: { transport: string; hwSerial?: string };
};
export type PortResource = { kind: "port"; port: number };
export type BuildResource = { kind: "build"; key: string };
export type Resource = DeviceResource | PortResource | BuildResource;

export type AgentOwner = { kind: "agent"; sessionId: string; cwd: string; repo?: string; worktree?: string };
export type UserOwner = { kind: "user"; pid: number; tty?: string; cwd: string; repo?: string; worktree?: string };
export type CiOwner = { kind: "ci"; runId: string };
export type Owner = AgentOwner | UserOwner | CiOwner;

export type Lease = {
	id: string;
	resource: Resource;
	owner: Owner;
	label?: string;
	acquiredAt: number;
	heartbeatAt: number;
	ttlMs: number;
	pid?: number;
	/** the owner booted this device (it was off when leased) — so it's theirs to shut down on release */
	bootedByOwner?: boolean;
	/**
	 * Heartbeat period of the process that holds this lease (`run` / `dev` / `batch` / `e2e`, which also
	 * record their own `pid`). With a pid, a dead pid makes the lease stale after `LOST_HEARTBEATS` periods.
	 */
	heartbeatMs?: number;
	/**
	 * The holding process (`warden dev`) lets its owner's other processes drive the device beside it: `warden ui`
	 * attaches to it instead of refusing with `device_busy`, and never releases it. Other owners still see it as foreign.
	 */
	shared?: boolean;
};

export type DeviceState = "booted" | "shutdown" | "booting";

/** A device as seen by a provider, enriched with warden's own bookkeeping. */
export type InventoryDevice = {
	platform: Platform;
	id: string;
	name: string;
	state: DeviceState;
	/** true when warden created this device (sim) or launched it (emulator) */
	wardenCreated: boolean;
	/** warden profile slug, e.g. `iphone-17` */
	profile?: string;
	/** runtime identifier or version, e.g. `iOS-26-5` */
	runtime?: string;
	/** a golden image (`warden-golden-*`): clone source only — never allocated, adopted, booted by gc or counted in a pool */
	golden?: boolean;
	/** reported bad: never allocated until `warden sim unquarantine` */
	quarantined?: boolean;
	/** a real phone/tablet: never booted, shut down, created, adopted, counted in capacity or recorded as a warden device */
	physical?: PhysicalInfo;
};

export type DeviceRequest = {
	platform: Platform;
	profile: string;
	runtime?: string;
	count: number;
	/** max warden-created devices for this platform+profile */
	max: number;
	/** allow allocating foreign (non-warden) devices that match the profile */
	adopt?: boolean;
	/** opt-in: only physical devices (optionally just these ids), never create or boot */
	physical?: { ids?: string[] };
};

export type AllocationStep =
	| { action: "reuse"; device: InventoryDevice }
	| { action: "boot"; device: InventoryDevice }
	| { action: "create"; name: string };

export type AllocationPlan =
	| { kind: "assign"; steps: AllocationStep[]; stale: string[] }
	| { kind: "wait"; available: number; needed: number; stale: string[] };

export function resourceKey(resource: Resource): string {
	switch (resource.kind) {
		case "device":
			return `device:${resource.platform}:${resource.id}`;
		case "port":
			return `port:${resource.port}`;
		case "build":
			return `build:${resource.key}`;
	}
}

export function describeOwner(owner: Owner): string {
	switch (owner.kind) {
		case "agent":
			return `agent ${owner.sessionId}`;
		case "user":
			return `user pid ${owner.pid}`;
		case "ci":
			return `ci ${owner.runId}`;
	}
}

/** Owner location for messages: `repo/worktree` when known. */
export function ownerLocation(owner: Owner): string | undefined {
	if (owner.kind === "ci") return undefined;
	const parts = [owner.repo, owner.worktree].filter((p): p is string => Boolean(p));
	return parts.length > 0 ? parts.join("/") : owner.cwd;
}

export function sameOwner(a: Owner, b: Owner): boolean {
	if (a.kind === "agent" && b.kind === "agent") return a.sessionId === b.sessionId;
	if (a.kind === "user" && b.kind === "user") return a.pid === b.pid;
	if (a.kind === "ci" && b.kind === "ci") return a.runId === b.runId;
	return false;
}

/** A claim waiting for host capacity to boot devices (`boot_queue` row). */
export type QueueEntry = {
	id: string;
	platform: Platform;
	profile: string;
	/** capacity units the boots need */
	units: number;
	/** numeric base priority (see `PRIORITY` in queue.ts); aging adds to it */
	priority: number;
	enqueuedAt: number;
	heartbeatAt: number;
	owner: Owner;
	label?: string;
	pid?: number;
};

/** The one constructor of a device lease resource: carries `physical` for real devices. */
export function deviceResourceOf(d: InventoryDevice): DeviceResource {
	const resource: DeviceResource = { kind: "device", platform: d.platform, id: d.id, name: d.name };
	if (d.physical) {
		resource.physical = {
			transport: d.physical.transport,
			...(d.physical.platform === "android" && d.physical.hwSerial !== undefined
				? { hwSerial: d.physical.hwSerial }
				: {}),
		};
	}
	return resource;
}

const PHYSICAL_IOS_ID = /^(?:[0-9A-F]{8}-[0-9A-F]{16}|[0-9a-f]{40})$/i;

/** An iPhone/iPad hardware UDID: `XXXXXXXX-XXXXXXXXXXXXXXXX` or 40 hex (older devices); a simulator UUID is neither. */
export function isPhysicalIosId(id: string): boolean {
	return PHYSICAL_IOS_ID.test(id);
}

/** A device warden may not boot, shut down, create, erase or count in host capacity. */
export function isPhysicalDevice(d: Pick<InventoryDevice, "physical">): boolean {
	return d.physical !== undefined;
}

/** Is a physical device usable now: an Android phone in adb state `device`, an iOS device its provider reports `booted` (paired and available). */
export function isPhysicalReady(d: InventoryDevice): boolean {
	if (!d.physical) return false;
	return d.physical.platform === "android" ? d.physical.adbState === "device" : d.state === "booted";
}
