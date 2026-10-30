import type {
	ClockCondition,
	HostFault,
	LocationCondition,
	NetworkCondition,
	PermissionName,
	PermissionState,
	TextSize,
} from "@delacour/warden-core/conditions/conditions.types";
import type { AsyncResult } from "@delacour/warden-types/result";

/**
 * The device driver contract every layer of warden-e2e builds on: the spec API (`screen`, `device`,
 * `app`), `warden ui`, specs and the devtools facet all talk to a `Driver`. Implementations:
 * `ios/ios-driver.ts` (warden-simd over NDJSON + `xcrun simctl`) and `android/android-driver.ts`
 * (persistent `adb shell` + uiautomator). `driver.testing.ts` has the scripted FakeDriver for tests.
 *
 * Frozen interface — change it only together with `docs/plans/wdn-e2e.md`.
 */

export type Platform = "ios" | "android";

export type DriverErrorCode =
	| "E_HELPER_MISSING"
	| "E_HELPER_CRASHED"
	| "E_TIMEOUT"
	| "E_NOT_BOOTED"
	// the helper's wire code is `E_UNKNOWN_UDID`; `mapWireError` (driver/ios/simd-protocol.ts) maps it to this
	| "E_UNKNOWN_DEVICE"
	| "E_AX_UNAVAILABLE"
	| "E_APP_UNAVAILABLE"
	| "E_APP_NOT_RESPONDING"
	| "E_NO_ELEMENT"
	| "E_STALE_REF"
	| "E_UNSUPPORTED"
	| "E_UNSUPPORTED_TEXT"
	| "E_HID"
	| "E_IO"
	| "E_BAD_REQUEST"
	| "E_INTERNAL"
	// a physical phone is locked behind a secure keyguard: warden cannot (and must not) unlock it
	| "E_DEVICE_LOCKED"
	// the request would change something on a physical device that warden did not put there
	| "E_REFUSED"
	// a network / clock condition needs the app launched with the warden dylib and the app is running without it
	| "E_NETWORK_RELAUNCH";

export type DriverError = { code: DriverErrorCode; message: string; retryable: boolean; detail?: unknown };

export type DriverResult<T> = AsyncResult<T, DriverError>;

/** Points on iOS (portrait-up screen space, same as AX frames), px on Android. */
export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };

/** A point on one finger's route; `t` = ms after touch-down. Every point of a gesture carries `t`, or none does. */
export type TouchPoint = Point & { t?: number };
/** One finger: down at the first point, through the rest, up at the last. All fingers go down and lift together. */
export type TouchPath = { points: readonly TouchPoint[] };
export type GestureOptions = {
	/** untimed paths only: first point to last, each finger at constant speed (by arc length). Default 300. */
	durationMs?: number;
	/** fingers still at their first points before moving (press-then-drag). Default 0. */
	holdMs?: number;
	/** fingers still at their last points before lifting (no fling). Default 0. */
	releaseMs?: number;
};
/**
 * `radius`: finger distance from the centre (default 100 pt on iOS, 100 x screen scale px on Android);
 * `angle`: the finger axis in degrees, 0 = horizontal.
 */
export type TwoFingerOptions = { durationMs?: number; radius?: number; angle?: number };

export type Role =
	| "button"
	| "text"
	| "textfield"
	| "securefield"
	| "searchfield"
	| "image"
	| "switch"
	| "checkbox"
	| "slider"
	| "link"
	| "cell"
	| "list"
	| "scrollview"
	| "tab"
	| "tabbar"
	| "alert"
	| "sheet"
	| "keyboard"
	| "navbar"
	| "toolbar"
	| "window"
	| "application"
	| "other";

/** One accessibility node, normalized across iOS (axbridge / ax) and Android (uiautomator). */
export type Element = {
	/** driver-local stable id for this snapshot (preorder path such as `0.3.1`, or the backend's unique id) */
	id: string;
	role: Role;
	/** iOS XCUI type (`Button`) or Android class (`android.widget.EditText`) */
	rawType: string;
	/** AX label / content-desc */
	label?: string;
	/** RN testID: iOS accessibilityIdentifier / Android resource-id without the package prefix */
	identifier?: string;
	/** AX value / Android text of inputs */
	value?: string;
	/** Android text; iOS: label of static text */
	text?: string;
	placeholder?: string;
	frame: Rect;
	/** `frame` as 0–1 fractions of the screen */
	normFrame: Rect;
	/** iOS decoded traits; Android flags (clickable, checkable, scrollable, …) */
	traits: string[];
	enabled: boolean;
	focused?: boolean;
	hidden?: boolean;
	selected?: boolean;
	checked?: boolean;
	/** only when reachability was requested (iOS ~18 ms per element) or derivable (Android) */
	hittable?: boolean;
	/** where to tap: iOS `interactable.actionable.at`, else the frame centre */
	tapPoint?: Point;
	pid?: number;
	/** screen-reader facts beyond the base tree; absent when the backend can't read them */
	a11y?: ElementA11y;
	depth: number;
	children: Element[];
};

/**
 * Screen-reader facts. Android: from warden-uiad's `AccessibilityNodeInfo`. iOS: from the ios-inject UIView walk,
 * merged by identifier / frame when an a11y read asks for it.
 */
export type ElementA11y = {
	/** iOS accessibilityHint / RN accessibilityHint */
	hint?: string;
	/** iOS custom action names / Android node action labels (standard actions left out) */
	actions?: readonly string[];
	/** reachable by VoiceOver / TalkBack navigation */
	focusable?: boolean;
	/** iOS isAccessibilityElement / Android importantForAccessibility; `false` = skipped by screen readers */
	important?: boolean;
	/** Android: holds TalkBack's accessibility focus */
	a11yFocused?: boolean;
	liveRegion?: "polite" | "assertive";
	/** iOS: index in the container's `accessibilityElements` order, when the app sets one */
	order?: number;
};

export type SnapshotBackend = "axbridge" | "ax" | "uiautomator";

export type ScreenInfo = { width: number; height: number; scale: number; rotation?: number };

export type ModalInfo = { pid?: number; description?: string };

export type Snapshot = {
	platform: Platform;
	backend: SnapshotBackend;
	takenAt: number;
	screen: ScreenInfo;
	/** the tree */
	elements: Element[];
	/** the same nodes in preorder (reading order is derived by consumers) */
	flat: Element[];
	truncated: boolean;
	modal?: ModalInfo;
};

export type Orientation = "portrait" | "portraitUpsideDown" | "landscapeLeft" | "landscapeRight";

export type HardwareButton = "home" | "back" | "lock" | "volumeUp" | "volumeDown" | "shake";

export type KeyName = "Enter" | "Backspace" | "Tab" | "Space" | "Escape" | "Delete" | "Up" | "Down" | "Left" | "Right";

export type Modifier = "shift" | "cmd" | "alt" | "ctrl";

/** What `Driver.biometrics` does: read the enrollment, (un)enroll, or present a matching / non-matching biometric. */
export type BiometricOp = "status" | "enroll" | "unenroll" | "match" | "fail";

/** `modality`: what the device scans, iOS Face ID (`face`) or Touch ID and Android (`fingerprint`). */
export type BiometricState = { enrolled: boolean; modality: "face" | "fingerprint" };

export type AlertInfo = { title?: string; message?: string; buttons: Element[] };

export type HealthInfo = {
	platform: Platform;
	id: string;
	version: string;
	/** iOS: negotiated HID transport; Android: `adb` */
	transport: string;
	/** iOS: `axbridge` availability */
	bridge?: "available" | "missing" | "failed";
	screen: ScreenInfo;
	detail?: Record<string, unknown>;
};

export type LaunchOptions = {
	/** extra launch arguments (iOS: after the bundle id; Android: intent extras are not supported in v1) */
	args?: readonly string[];
	env?: Record<string, string>;
	/** iOS: `--terminate-running-process`; Android: `am force-stop` first. Default true. */
	relaunch?: boolean;
	/**
	 * iOS: load the warden network dylib even though no condition is set yet, so `network()` can take effect later
	 * without a relaunch (a suite that declares `conditions.network` launches this way). Conditions set before the
	 * launch inject on their own, a plain launch pays nothing. Ignored on Android.
	 */
	inject?: boolean;
};

/** Options of `Driver.network`. */
export type NetworkOptions = {
	/** iOS: the app to check for the dylib (default: the last app this driver launched) */
	bundleId?: string;
	/** iOS: relaunch a running app that lacks the dylib instead of failing with `E_NETWORK_RELAUNCH` */
	relaunch?: boolean;
};

export type DriverCapabilities = {
	/** two-finger `pinch` and `rotate` */
	pinch: boolean;
	/** most fingers `gesture` takes: 2 multi-touch, 1 single-finger paths only, 0 no `gesture` */
	maxPointers: 0 | 1 | 2;
	unicodeText: boolean;
	nativeSettle: boolean;
	alerts: boolean;
	reachability: boolean;
	/**
	 * `elementAtPoint` costs far less than a whole `snapshot` (iOS: one AX hit-test, ~10 ms, against ~76 ms), so a tap
	 * may check the snapshot an assertion just kept with one hit-test instead of taking another. Absent = no (Android's
	 * hit-test is a whole snapshot).
	 */
	cheapHitTest?: boolean;
};

export type AppCommands = {
	launch(bundleId: string, opts?: LaunchOptions): DriverResult<void>;
	terminate(bundleId: string): DriverResult<void>;
	openUrl(url: string): DriverResult<void>;
	install(path: string): DriverResult<void>;
	uninstall(bundleId: string): DriverResult<void>;
	isInstalled(bundleId: string): DriverResult<boolean>;
	isRunning(bundleId: string): DriverResult<boolean>;
	/** wipe app data, keep the build (iOS: core `resetAppData`; Android: `pm clear`) */
	clearData(bundleId: string, opts?: { keychain?: boolean }): DriverResult<void>;
};

export interface Driver {
	readonly platform: Platform;
	/** udid (iOS) or serial (Android) */
	readonly id: string;
	readonly capabilities: DriverCapabilities;
	health(): DriverResult<HealthInfo>;
	snapshot(opts?: { interactiveOnly?: boolean; backend?: SnapshotBackend }): DriverResult<Snapshot>;
	elementAtPoint(point: Point, opts?: { reachability?: boolean }): DriverResult<Element | null>;
	tap(point: Point, opts?: { count?: number; durationMs?: number }): DriverResult<void>;
	longPress(point: Point, opts?: { durationMs?: number }): DriverResult<void>;
	swipe(from: Point, to: Point, opts?: { durationMs?: number; momentum?: boolean }): DriverResult<void>;
	drag(
		from: Point,
		to: Point,
		opts?: { pressMs?: number; durationMs?: number; releaseMs?: number }
	): DriverResult<void>;
	/** Two fingers around `center` spread (`scale` > 1) or close (< 1). */
	pinch(center: Point, scale: number, opts?: TwoFingerOptions): DriverResult<void>;
	/** Two fingers turn `degrees` around `center`; positive is clockwise on screen. */
	rotate(center: Point, degrees: number, opts?: TwoFingerOptions): DriverResult<void>;
	/** 1-2 finger paths on one timeline (`driver/gesture-geometry.ts`); fingers go down and lift together. */
	gesture(paths: readonly TouchPath[], opts?: GestureOptions): DriverResult<void>;
	/** iOS: HID keyboard → paste fallback for non-ASCII; Android: `input text` (ASCII only) */
	typeText(text: string): DriverResult<void>;
	key(key: KeyName, modifiers?: readonly Modifier[]): DriverResult<void>;
	pressButton(button: HardwareButton): DriverResult<void>;
	screenshot(opts?: { path?: string; scale?: number }): DriverResult<{ path?: string; png?: Uint8Array }>;
	orientation(set?: Orientation): DriverResult<Orientation>;
	/** wait for a quiet UI: iOS axbridge quiescence, else snapshot-hash polling */
	settle(opts?: { quietMs?: number; timeoutMs?: number }): DriverResult<{ quiet: boolean; waitedMs: number }>;
	/** the system alert / sheet on top, if any */
	alert(): DriverResult<AlertInfo | null>;
	appearance(set?: "light" | "dark"): DriverResult<"light" | "dark">;
	clipboard(set?: string): DriverResult<string>;
	/**
	 * Put the device's network into `op` (offline / online / a preset / custom speed and latency) and return what
	 * is now in effect. Android emulator: native, verified through `dumpsys connectivity`. iOS: per app, the app
	 * is launched with a dylib that routes it through the lease proxy (`E_NETWORK_RELAUNCH` when it runs without).
	 * `flap` alternates the base with offline in this process (`conditions/scheduler.ts`) until the next network op
	 * or `close()` (Android; iOS goes through the scheduler directly).
	 */
	network(op: NetworkCondition, opts?: NetworkOptions): DriverResult<NetworkState>;
	/**
	 * Replace the per-host faults (status / reset / delay / blackhole by host glob). Both platforms route the app
	 * through the lease's shaping proxy for this. `notes` carries what the proxy cannot do as written (an https://
	 * request matching a `status` fault is reset, the proxy does not decrypt TLS). `[]` clears them.
	 */
	networkFaults(faults: readonly HostFault[]): DriverResult<{ notes: readonly string[] }>;
	/**
	 * Simulated location: a point, a route (waypoints or GPX, played at `speedMps`), a bundled scenario, or clear.
	 * iOS: `simctl location` (the sim plays routes itself, no loop). Android: emulator `geo fix`, routes ticked by
	 * warden until the next op or `close()`; `clear` keeps the last fix. Physical devices: `E_UNSUPPORTED`.
	 */
	location(op: LocationCondition): DriverResult<void>;
	/**
	 * Mock the device's wall clock (monotonic clocks are never touched). `offset` shifts it from the real time,
	 * `fixed` sets it to an instant and lets it run, `frozen` holds it there, `real` puts it back. Android emulator:
	 * system time (`settings put global auto_time 0` + `cmd alarm set-time`), device-wide; no `frozen`
	 * (`E_UNSUPPORTED`). iOS: the injected dylib shifts or holds the clocks of the injected app only (live, no
	 * relaunch); an app without the dylib gets it from the next launch (`appliesOnLaunch`), or from a relaunch with
	 * `relaunch: true`. Large offsets break TLS validity (HTTPS fails once the clock passes a certificate's dates).
	 */
	clock(op: ClockCondition, opts?: NetworkOptions): DriverResult<ClockState>;
	/**
	 * Set runtime permissions of an app, per name (`location`, `camera`, `photos`, `notifications`, ...): `granted`,
	 * `denied` (revoked) or `unset` (back to asking). Names a platform has no service for are listed in `skipped`;
	 * when none applies it is `E_UNSUPPORTED`. iOS: `simctl privacy` (terminates a running app). Android: `pm
	 * grant|revoke` of the permissions the app declares. Apply before the first launch.
	 */
	permissions(grants: PermissionGrants, opts?: SettingOptions): DriverResult<PermissionsState>;
	/**
	 * Device timezone (IANA name); `null` puts it back. Android: `cmd alarm set-timezone`, device-wide, live. iOS: a
	 * simulator has none per device, so it is staged and the app launched next gets it as `TZ` (`appliesOnLaunch`).
	 * `previous` is the Android timezone to restore on `null` (default: the host's).
	 */
	timezone(tz: string | null, opts?: { previous?: string }): DriverResult<TimezoneState>;
	/**
	 * Locale of an app (BCP 47, `fr-FR`); `null` puts it back. Android 13+: per-app locale (`cmd locale
	 * set-app-locales`), live. iOS: staged for the next launch as `-AppleLanguages` / `-AppleLocale`.
	 */
	locale(tag: string | null, opts?: SettingOptions): DriverResult<LocaleState>;
	/**
	 * Accessibility settings: text size, bold text, contrast, reduce motion; `null` puts them back. iOS: `simctl ui
	 * content_size` / `increase_contrast` (no bold text or reduce motion: `skipped`). Android: `font_scale`,
	 * `font_weight_adjustment` (no contrast or reduce motion: `skipped`).
	 */
	a11y(op: A11yOp | null): DriverResult<A11yState>;
	/**
	 * Battery level and charging; `null` puts the real battery back. Android emulator: `dumpsys battery`, seen by the
	 * OS and the app. iOS: status bar override only (`cosmetic: true`): the app still reads the real battery.
	 */
	battery(op: BatteryOp | null): DriverResult<BatteryState>;
	/** Android: `am send-trim-memory RUNNING_CRITICAL` to the running app. iOS: `E_UNSUPPORTED` (no way verified to reach an app). */
	memoryWarning(opts?: SettingOptions): DriverResult<void>;
	/** iOS: `simctl push` of an APNs payload (needs `aps`) to the app. Android: `E_UNSUPPORTED`. */
	push(payload: PushPayload, opts?: SettingOptions): DriverResult<void>;
	/** Simulated biometrics (simulators / emulators only, else `E_UNSUPPORTED`); answers the state after the op. */
	biometrics(op: BiometricOp): DriverResult<BiometricState>;
	readonly app: AppCommands;
	close(): Promise<void>;
}

/** Parts of a network condition no native mechanism does; the per-lease shaping proxy (COND-4) carries them. */
export type NetworkProxyFeature = "loss";

/**
 * What `Driver.network` left on the device. `online` is what the OS reports (verified, not assumed);
 * `needsProxy` lists the asked-for parts that were NOT applied because they need the shaping proxy.
 */
export type NetworkState = {
	online: boolean;
	condition: NetworkCondition;
	needsProxy: readonly NetworkProxyFeature[];
	/**
	 * iOS: the condition is staged (proxy configured, state written) but no running app carries the dylib yet; it
	 * reaches the app launched next. Absent = in effect now.
	 */
	appliesOnLaunch?: true;
};

/** The app a setting is for (default: the last app this driver launched, else the one the session names). */
export type SettingOptions = { bundleId?: string };

export type PermissionGrants = Partial<Record<PermissionName, PermissionState>>;

export type PermissionsState = {
	bundleId: string;
	applied: readonly { permission: PermissionName; state: PermissionState }[];
	/** names this platform has no service for, with why */
	skipped: readonly { permission: PermissionName; reason: string }[];
};

export type TimezoneState = {
	/** the timezone in effect (or staged), absent after a reset on iOS */
	timezone?: string;
	/** Android: the timezone before this change */
	previous?: string;
	/** iOS: staged for the next launch */
	appliesOnLaunch?: true;
};

export type LocaleState = {
	locale?: string;
	bundleId?: string;
	appliesOnLaunch?: true;
};

export type A11yOp = {
	textSize?: TextSize;
	boldText?: boolean;
	contrast?: "increased" | "normal";
	reduceMotion?: boolean;
};

export type A11yState = {
	applied: readonly string[];
	/** asked for but this platform has no mechanism that works, with why */
	skipped: readonly { setting: string; reason: string }[];
	/** the Android font scale was clamped to the platform's range */
	notes: readonly string[];
};

export type BatteryOp = { level?: number; charging?: boolean };

export type BatteryState = { level?: number; charging?: boolean; cosmetic: boolean };

/** An APNs payload: an object with an `aps` key (4096 bytes at most). */
export type PushPayload = { aps: Record<string, unknown> } & Record<string, unknown>;

/** What `Driver.clock` left on the device. */
export type ClockState = {
	condition: ClockCondition;
	/** wall clock minus the host's, ms (0 for `real` and `frozen`) */
	offsetMs: number;
	frozen: boolean;
	/** what the device's wall clock read when the op returned, ms since the epoch */
	nowMs: number;
	/** iOS: staged for the next launch of the app; absent = in effect now */
	appliesOnLaunch?: true;
};

export type Logger = (line: string) => void;
