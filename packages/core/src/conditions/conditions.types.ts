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

export type KeyboardMode = "software" | "hardware";

export const KEYBOARD_MODES: readonly KeyboardMode[] = ["software", "hardware"];

/** What every warden-leased device starts on and what release restores: the on-screen keyboard shows. */
export const DEFAULT_KEYBOARD_MODE: KeyboardMode = "software";

/** `software`: the on-screen keyboard shows; `hardware`: it is hidden, input arrives as from a connected keyboard. */
export type KeyboardCondition = { mode: KeyboardMode; previousIme?: ImeState };

/** Global settings holding the IME state `hardware` mode switched off (survives the driver process). */
export const IME_STASH_ENABLED = "warden_ime_enabled";
export const IME_STASH_DEFAULT = "warden_ime_default";

/**
 * Android only: the input methods `hardware` mode switched off, recorded so release puts them back exactly.
 * `enabled` is `settings secure enabled_input_methods` and `default` is `default_input_method` (empty = none).
 */
export type ImeState = { enabled: string; default: string };

export type CameraFacing = "back" | "front";

export const CAMERA_FACINGS: readonly CameraFacing[] = ["back", "front"];

/** A staged asset the simulated camera plays; `path` is the staged copy under the device's camera dir. */
export type CameraFeed = { kind: "image"; path: string } | { kind: "video"; path: string; loop: boolean };

/** The simulated camera per facing; a facing left out has no camera (iOS) or the emulator's default (Android). */
export type CameraCondition = Partial<Record<CameraFacing, CameraFeed>>;

/**
 * What the virtual authenticator answers an app's passkey call with. `auto` succeeds without UI; `cancel` is the
 * user dismissing the sheet; `fail` is the platform refusing (iOS 1004, Android `NotAllowedError`); `unavailable` is
 * an assertion with no credential to offer (iOS 1001 + "No credentials available", Android Play images: the
 * cancellation exception, indistinguishable from `cancel`).
 */
export const PASSKEY_MODES = ["auto", "cancel", "fail", "unavailable"] as const;
export type PasskeyMode = (typeof PASSKEY_MODES)[number];
export const DEFAULT_PASSKEY_MODE: PasskeyMode = "auto";

/**
 * User verification: `match` sets the UV flag; `nomatch` behaves like a failed Face ID / fingerprint the user gave up
 * on (iOS 1001, Android cancellation); `skip` answers without UV (flag 0), for servers that require it.
 */
export const PASSKEY_UV = ["match", "nomatch", "skip"] as const;
export type PasskeyUv = (typeof PASSKEY_UV)[number];
export const DEFAULT_PASSKEY_UV: PasskeyUv = "match";

export const isPasskeyMode = (v: string): v is PasskeyMode => (PASSKEY_MODES as readonly string[]).includes(v);
export const isPasskeyUv = (v: string): v is PasskeyUv => (PASSKEY_UV as readonly string[]).includes(v);

/**
 * One credential of the virtual authenticator, the W3C / CDP virtual-authenticator record shape. Binary fields are
 * base64url. `privateKey` is a PKCS#8 DER P-256 key: test keys only, never a production relying party's.
 */
export type PasskeyCredential = {
	credentialId: string;
	rpId: string;
	userHandle: string;
	userName: string;
	displayName: string;
	privateKey: string;
	signCount: number;
	/** ms since the epoch; an assertion without `allowCredentials` picks the newest for the rp */
	createdAt: number;
	backupEligible: boolean;
	backupState: boolean;
};

/** Android: warden's credential-provider app (the virtual authenticator), installed while the lease uses passkeys. */
export const PASSKEY_PROVIDER_PACKAGE = "nz.co.delacour.warden.passkeys";

/** Android only: the credential-provider settings before warden's provider was enabled, restored on release. */
export type PasskeyProviderSettings = {
	/** `settings secure credential_service` (`:`-separated components), `null` when it was unset */
	service: string | null;
	/** `settings secure credential_service_primary`, `null` when it was unset */
	primary: string | null;
};

/**
 * The virtual authenticator on a lease's device. Credentials are not part of the record: they live in the device's
 * store file (`passkey-store.ts`), written by the authenticator itself, and go with the lease.
 */
export type PasskeyCondition = { mode: PasskeyMode; uv: PasskeyUv; previousProvider?: PasskeyProviderSettings };

/** Everything a lease can have set on its device, one slot per area. */
export type ConditionValues = {
	network: NetworkCondition;
	location: LocationCondition;
	clock: ClockCondition;
	permission: PermissionCondition;
	locale: LocaleCondition;
	a11y: A11yCondition;
	battery: BatteryCondition;
	camera: CameraCondition;
	keyboard: KeyboardCondition;
	passkeys: PasskeyCondition;
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
	"camera",
	"keyboard",
	"passkeys",
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
