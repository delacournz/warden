export type Platform = "ios" | "android";

export type DeviceResource = { kind: "device"; platform: Platform; id: string; name: string };
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
