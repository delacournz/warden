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

/** The permission names a spec, `warden ui permission` and a suite's `conditions.permissions` use; each maps to platform services in the driver. */
export const PERMISSION_NAMES = [
	"location",
	"locationAlways",
	"camera",
	"photos",
	"photosAdd",
	"contacts",
	"contactsLimited",
	"notifications",
	"microphone",
	"calendar",
	"reminders",
	"motion",
	"mediaLibrary",
	"siri",
] as const;
export type PermissionName = (typeof PERMISSION_NAMES)[number];

export const isPermissionName = (v: string): v is PermissionName => (PERMISSION_NAMES as readonly string[]).includes(v);

/** Runtime permission grants applied to apps on the device. */
export type PermissionCondition = {
	grants: readonly { bundleId: string; permission: PermissionName; state: PermissionState }[];
};

/** Locale applies to one app (`bundleId`); timezone to the device (Android) or the next launch (iOS). */
export type LocaleCondition = {
	locale?: string;
	timezone?: string;
	bundleId?: string;
	/** Android: the timezone before the first change, put back on release */
	previousTimezone?: string;
};

/** A named text size (iOS content size categories) or a font scale where 1 is the default. */
export type TextSize = (typeof TEXT_SIZE_NAMES)[number] | number;

export const TEXT_SIZE_NAMES = [
	"extra-small",
	"small",
	"medium",
	"large",
	"extra-large",
	"extra-extra-large",
	"extra-extra-extra-large",
	"accessibility-medium",
	"accessibility-large",
	"accessibility-extra-large",
	"accessibility-extra-extra-large",
	"accessibility-extra-extra-extra-large",
] as const;

export type A11yCondition = {
	textSize?: TextSize;
	/** resolved font scale of `textSize` (1 = default) */
	fontScale?: number;
	reduceMotion?: boolean;
	boldText?: boolean;
	contrast?: "increased" | "normal";
	reduceTransparency?: boolean;
	buttonShapes?: boolean;
	differentiateWithoutColor?: boolean;
	onOffLabels?: boolean;
	highContrastText?: boolean;
	colorInversion?: boolean;
	screenReader?: boolean;
	/**
	 * Android TalkBack: the `enabled_accessibility_services` and `accessibility_enabled` values (`null` = unset) the
	 * device had before warden turned TalkBack on, so undo puts back exactly those and never drops a service warden
	 * did not add. Present only while `screenReader` is true on Android.
	 */
	screenReaderPrevious?: { services: string | null; enabled: string | null };
};

/** `cosmetic`: the status bar says so, the OS and the app still see the real battery (iOS simulators) */
export type BatteryCondition = { level?: number; charging?: boolean; cosmetic?: boolean };

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
