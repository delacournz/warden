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
	| "E_INTERNAL";

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
	depth: number;
	children: Element[];
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
	readonly app: AppCommands;
	close(): Promise<void>;
}

export type Logger = (line: string) => void;
