export type NetworkPreset = "edge" | "3g" | "4g" | "lte" | "wifi" | "slow" | "lossy";

export type NetworkCondition =
	| { kind: "online" }
	| { kind: "offline" }
	| { kind: "preset"; preset: NetworkPreset }
	| { kind: "custom"; latencyMs?: number; jitterMs?: number; downKbps?: number; upKbps?: number; lossPct?: number }
	| { kind: "flap"; upMs: number; downMs: number; jitterPct?: number; base?: NetworkCondition };

/** A per-host fault the lease's shaping proxy applies; `match` is a host glob. */
export type HostFault = {
	match: string;
	action: { kind: "status"; code: number } | { kind: "reset" } | { kind: "delay"; ms: number } | { kind: "blackhole" };
};

export type LatLon = { lat: number; lon: number };

export type LocationScenario = "city-run" | "city-bike" | "freeway";

export type LocationCondition =
	| { kind: "point"; lat: number; lon: number; altM?: number }
	| { kind: "route"; points: readonly LatLon[]; speedMps?: number; intervalS?: number; loop?: boolean }
	| { kind: "gpx"; path: string; speedMps?: number }
	| { kind: "scenario"; name: LocationScenario }
	| { kind: "clear" };

export type ClockCondition =
	| { kind: "real" }
	| { kind: "offset"; ms: number }
	| { kind: "fixed"; at: string }
	| { kind: "frozen"; at: string };

export type PermissionState = "granted" | "denied" | "unset";

/** Runtime permission grants applied to apps on the device; later phases may extend. */
export type PermissionCondition = {
	grants: readonly { bundleId: string; permission: string; state: PermissionState }[];
};

export type LocaleCondition = { locale?: string; timezone?: string };

export type A11yCondition = { fontScale?: number; reduceMotion?: boolean; boldText?: boolean };

export type BatteryCondition = { level?: number; charging?: boolean };

/** Everything a lease can have set on its device, one slot per area. */
export type ConditionValues = {
	network: NetworkCondition;
	location: LocationCondition;
	clock: ClockCondition;
	permission: PermissionCondition;
	locale: LocaleCondition;
	a11y: A11yCondition;
	battery: BatteryCondition;
};

export type ConditionArea = keyof ConditionValues;

/** Display/iteration order; also the order undo resets areas in. */
export const CONDITION_AREAS: readonly ConditionArea[] = [
	"network",
	"location",
	"clock",
	"permission",
	"locale",
	"a11y",
	"battery",
];

/** A process warden spawned to hold a condition (shaping proxy, route ticker); undo kills it. */
export type OwnedProcess = { kind: "pid"; pid: number };

/** One active condition on a lease, discriminated by `area`. */
export type ConditionRecord = {
	[A in ConditionArea]: {
		area: A;
		value: ConditionValues[A];
		/** processes undo must stop */
		owned: readonly OwnedProcess[];
		setAt: number;
	};
}[ConditionArea];
