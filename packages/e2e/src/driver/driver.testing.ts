import type {
	ClockCondition,
	HostFault,
	LocationCondition,
	NetworkCondition,
	PermissionName,
	PermissionState,
} from "@delacour/warden-core/conditions/conditions.types";
import type { Result } from "@delacour/warden-types/result";
import type { ScreenReaderState } from "../a11y/a11y.types";
import type { A11yEventsRead, ReadsA11yEvents } from "./a11y-events";
import type { ReadsA11y } from "./a11y-read";
import type { AlertBackend, ProbesFrontmost, ReadsAlertOn } from "./alerts";
import type {
	A11yOp,
	A11yState,
	AlertInfo,
	AppCommands,
	BatteryOp,
	BatteryState,
	BiometricOp,
	ClockState,
	Driver,
	DriverCapabilities,
	DriverError,
	DriverResult,
	Element,
	GestureOptions,
	HardwareButton,
	HealthInfo,
	KeyName,
	LaunchOptions,
	LocaleState,
	Modifier,
	NetworkState,
	Orientation,
	PermissionGrants,
	PermissionsState,
	Platform,
	Point,
	PushPayload,
	Rect,
	Role,
	ScreenInfo,
	SettingOptions,
	Snapshot,
	SnapshotBackend,
	TimezoneState,
	TouchPath,
	TwoFingerOptions,
} from "./driver.types";
import type { ActsOnElements, ScrollDirection } from "./element-actions";
import { driverError } from "./errors";
import { planGesture } from "./gesture-geometry";
import type { AuditsNatively, NativeAuditOptions, NativeAuditResult } from "./native-audit";
import { faultNotes } from "./network-proxy";
import type { DrivesScreenReader, SpokenRead } from "./screen-reader";
import type { PastesText, SelectsAll, SetsText } from "./typing";

/**
 * Test doubles for `Driver`: `fakeDriver` (scripted screens, records every call) and the element-tree
 * builders `el` / `snapshotOf` so fixtures stay one-liners. Never touches a device.
 */

export const FAKE_SCREEN: ScreenInfo = { width: 390, height: 844, scale: 3 };

/** What `el()` takes: `id` is the RN testID (`Element.identifier`); `Element.id` is derived by `snapshotOf`. */
export type ElementSpec = {
	role: Role;
	rawType?: string;
	label?: string;
	id?: string;
	value?: string;
	text?: string;
	placeholder?: string;
	frame?: Rect;
	traits?: string[];
	enabled?: boolean;
	focused?: boolean;
	hidden?: boolean;
	selected?: boolean;
	checked?: boolean;
	hittable?: boolean;
	tapPoint?: Point;
	children?: ElementSpec[];
};

export type ElementOptions = Omit<ElementSpec, "role">;

export function el(role: Role, options: ElementOptions = {}): ElementSpec {
	return { role, ...options };
}

export type SnapshotOptions = {
	platform?: Platform;
	backend?: SnapshotBackend;
	screen?: ScreenInfo;
	takenAt?: number;
	truncated?: boolean;
	modal?: Snapshot["modal"];
};

const ROW_HEIGHT = 44;
const ROW_PITCH = 50;

function titleCase(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

function normalise(frame: Rect, screen: ScreenInfo): Rect {
	return {
		x: frame.x / screen.width,
		y: frame.y / screen.height,
		width: frame.width / screen.width,
		height: frame.height / screen.height,
	};
}

const OPTIONAL_KEYS = [
	"label",
	"value",
	"text",
	"placeholder",
	"focused",
	"hidden",
	"selected",
	"checked",
	"hittable",
	"tapPoint",
] as const;

/** Only the optional `Element` fields the spec actually sets (`id` becomes `identifier`). */
function optionalFields(spec: ElementSpec): Partial<Element> {
	const fields: Partial<Element> = {};
	for (const key of OPTIONAL_KEYS) {
		const value = spec[key];
		if (value !== undefined) Object.assign(fields, { [key]: value });
	}
	if (spec.id !== undefined) fields.identifier = spec.id;
	return fields;
}

/**
 * Build a full `Snapshot` from specs: preorder `flat`, path ids (`0.3.1`), depth and `normFrame`.
 * Specs without a `frame` are laid out as full-width rows, one per preorder index (50 pt pitch).
 */
export function snapshotOf(specs: readonly ElementSpec[], options: SnapshotOptions = {}): Snapshot {
	const screen = options.screen ?? FAKE_SCREEN;
	const platform = options.platform ?? "ios";
	const flat: Element[] = [];
	const build = (spec: ElementSpec, path: string, depth: number): Element => {
		const row = flat.length;
		const frame = spec.frame ?? { x: 0, y: row * ROW_PITCH, width: screen.width, height: ROW_HEIGHT };
		const element: Element = {
			id: path,
			role: spec.role,
			rawType: spec.rawType ?? titleCase(spec.role),
			frame,
			normFrame: normalise(frame, screen),
			traits: spec.traits ?? [],
			enabled: spec.enabled ?? true,
			depth,
			children: [],
		};
		Object.assign(element, optionalFields(spec));
		flat.push(element);
		element.children = (spec.children ?? []).map((child, index) => build(child, `${path}.${index}`, depth + 1));
		return element;
	};
	const elements = specs.map((spec, index) => build(spec, `${index}`, 0));
	const snapshot: Snapshot = {
		platform,
		backend: options.backend ?? (platform === "ios" ? "axbridge" : "uiautomator"),
		takenAt: options.takenAt ?? 0,
		screen,
		elements,
		flat,
		truncated: options.truncated ?? false,
	};
	if (options.modal) snapshot.modal = options.modal;
	return snapshot;
}

/** One entry per `Driver` method call (app commands are `app.*`). */
export type DriverCall =
	| { method: "health" }
	| { method: "snapshot"; opts?: { interactiveOnly?: boolean; backend?: SnapshotBackend } }
	| { method: "elementAtPoint"; point: Point; opts?: { reachability?: boolean } }
	| { method: "tap"; point: Point; opts?: { count?: number; durationMs?: number } }
	| { method: "longPress"; point: Point; opts?: { durationMs?: number } }
	| { method: "swipe"; from: Point; to: Point; opts?: { durationMs?: number; momentum?: boolean } }
	| {
			method: "drag";
			from: Point;
			to: Point;
			opts?: { pressMs?: number; durationMs?: number; releaseMs?: number };
	  }
	| { method: "pinch"; center: Point; scale: number; opts?: TwoFingerOptions }
	| { method: "rotate"; center: Point; degrees: number; opts?: TwoFingerOptions }
	| { method: "gesture"; paths: readonly TouchPath[]; opts?: GestureOptions }
	| { method: "typeText"; text: string }
	| { method: "key"; key: KeyName; modifiers?: readonly Modifier[] }
	| { method: "selectAll" }
	| { method: "setText"; text: string }
	| { method: "pasteText"; text: string }
	| { method: "pressElement"; element: Element }
	| { method: "scrollElement"; direction: ScrollDirection; within?: Element }
	| { method: "pressButton"; button: HardwareButton }
	| { method: "screenshot"; opts?: { path?: string; scale?: number } }
	| { method: "orientation"; set?: Orientation }
	| { method: "settle"; opts?: { quietMs?: number; timeoutMs?: number } }
	| { method: "alert" }
	| { method: "alertOn"; backend: AlertBackend }
	| { method: "isFrontmost"; bundleId: string }
	| { method: "readA11y" }
	| { method: "a11yEvents"; since?: number }
	| { method: "auditNatively"; options?: NativeAuditOptions }
	| { method: "screenReaderState" }
	| { method: "screenReaderNext" }
	| { method: "screenReaderPrev" }
	| { method: "screenReaderActivate" }
	| { method: "screenReaderFocused" }
	| { method: "screenReaderSpoken"; since?: number }
	| { method: "appearance"; set?: "light" | "dark" }
	| { method: "clipboard"; set?: string }
	| { method: "network"; op: NetworkCondition }
	| { method: "networkFaults"; faults: readonly HostFault[] }
	| { method: "location"; op: LocationCondition }
	| { method: "clock"; op: ClockCondition }
	| { method: "permissions"; grants: PermissionGrants; opts?: SettingOptions }
	| { method: "timezone"; tz: string | null; opts?: { previous?: string } }
	| { method: "locale"; tag: string | null; opts?: SettingOptions }
	| { method: "a11y"; op: A11yOp | null }
	| { method: "battery"; op: BatteryOp | null }
	| { method: "memoryWarning"; opts?: SettingOptions }
	| { method: "push"; payload: PushPayload; opts?: SettingOptions }
	| { method: "biometrics"; op: BiometricOp }
	| { method: "app.launch"; bundleId: string; opts?: LaunchOptions }
	| { method: "app.terminate"; bundleId: string }
	| { method: "app.openUrl"; url: string }
	| { method: "app.install"; path: string }
	| { method: "app.uninstall"; bundleId: string }
	| { method: "app.isInstalled"; bundleId: string }
	| { method: "app.isRunning"; bundleId: string }
	| { method: "app.clearData"; bundleId: string; opts?: { keychain?: boolean } }
	| { method: "close" };

export type DriverMethod = DriverCall["method"];

/** Return from `onCall` to replace the default behaviour of one call. */
export type FakeOverride = { error: DriverError } | { data: unknown };

export type FakeDriverOptions = {
	/** one screen per `advance()` (the last one sticks) or a function evaluated per snapshot */
	screens: readonly Snapshot[] | (() => Snapshot);
	platform?: Platform;
	id?: string;
	/** host wall time the fake `clock` op measures from (default `Date.now`) */
	wallNow?: () => number;
	capabilities?: Partial<DriverCapabilities>;
	/** offer the optional `SelectsAll` capability (calls are recorded as `selectAll`); a plain driver has none */
	selectAll?: boolean;
	/** offer the optional `SetsText` capability (calls are recorded as `setText`); a plain driver has none */
	setText?: boolean;
	/** offer the optional `PastesText` capability (calls are recorded as `pasteText`); a plain driver has none */
	pasteText?: boolean;
	/**
	 * Offer the optional `ActsOnElements` capability (calls are recorded as `pressElement` / `scrollElement`) and
	 * answer whether the driver handled the action (default false: the caller sends the touch). A plain driver has none.
	 */
	elementActions?: { handled: boolean };
	/** inspect every call (after it is recorded); return an override to fail it or fake its result */
	onCall?: (call: DriverCall) => FakeOverride | undefined;
	/**
	 * Offer the optional `alertOn` capability (`driver/alerts.ts`); the listed readers see the screen's alert, the
	 * others report none. Absent = a driver with only `alert()`.
	 */
	alertBackends?: readonly AlertBackend[];
	/**
	 * A tap on an alert's button answers it (the alert reads as none until the screen changes), except the first
	 * `swallowAlertTaps` taps, which do nothing (a sheet still animating in). Default: taps never change the screen.
	 */
	answerAlertOnTap?: boolean;
	swallowAlertTaps?: number;
	/** Offer the optional `isFrontmost` capability: the bundle id of the app in front (evaluated per call). */
	frontmost?: () => string | undefined;
	/** Offer the optional `ReadsA11y` capability: the snapshot the driver would hand back with `Element.a11y` filled in. */
	readA11y?: (snapshot: Snapshot) => Snapshot;
	/** Offer the optional `ReadsA11yEvents` capability (cursor semantics are the function's own). */
	a11yEvents?: (since?: number) => A11yEventsRead;
	/** Offer the optional `AuditsNatively` capability. */
	auditNatively?: (options?: NativeAuditOptions) => NativeAuditResult;
	/**
	 * Offer the optional `DrivesScreenReader` capability (all six calls, recorded as `screenReader*`). Unset members
	 * answer a quiet default: state `real`/`talkback`, no focus, nothing spoken.
	 */
	screenReader?: Partial<{
		state: () => ScreenReaderState;
		next: () => Element | undefined;
		prev: () => Element | undefined;
		activate: () => void;
		focused: () => Element | undefined;
		spoken: (since?: number) => SpokenRead;
	}>;
};

export type FakeDriver = Driver &
	Partial<SelectsAll> &
	Partial<SetsText> &
	Partial<PastesText> &
	Partial<ActsOnElements> &
	Partial<ReadsAlertOn & ProbesFrontmost & ReadsA11y & ReadsA11yEvents & AuditsNatively & DrivesScreenReader> & {
		/** every call so far, in order */
		readonly calls: DriverCall[];
		/** the screen `snapshot()` currently returns */
		readonly screen: Snapshot;
		/** move to the next scripted screen (clamped to the last) */
		advance(): void;
		/** replace the current screen; with a function source this pins a fixed screen */
		set(screen: Snapshot): void;
		/** calls of one method, typed */
		callsOf<M extends DriverMethod>(method: M): Extract<DriverCall, { method: M }>[];
		closed: boolean;
	};

const DEFAULT_CAPABILITIES: DriverCapabilities = {
	pinch: true,
	maxPointers: 2,
	unicodeText: false,
	nativeSettle: false,
	alerts: true,
	reachability: true,
};

function area(rect: Rect): number {
	return rect.width * rect.height;
}

function contains(rect: Rect, point: Point): boolean {
	return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

/** Smallest element under the point; later (deeper / later in preorder) wins ties. */
function hitTest(snapshot: Snapshot, point: Point): Element | null {
	let best: Element | null = null;
	for (const element of snapshot.flat) {
		if (element.hidden || !contains(element.frame, point)) continue;
		if (!best || area(element.frame) <= area(best.frame)) best = element;
	}
	return best;
}

function findAlert(snapshot: Snapshot): AlertInfo | null {
	const alert = snapshot.flat.find((element) => element.role === "alert" || element.role === "sheet");
	if (!alert) return null;
	const collect = (element: Element): Element[] =>
		element.children.flatMap((child) => (child.role === "button" ? [child] : collect(child)));
	const texts = alert.children.filter((child) => child.role === "text");
	const info: AlertInfo = { buttons: collect(alert) };
	const title = alert.label ?? texts[0]?.label;
	const message = texts[1]?.label;
	if (title !== undefined) info.title = title;
	if (message !== undefined) info.message = message;
	return info;
}

export function fakeDriver(options: FakeDriverOptions): FakeDriver {
	const platform = options.platform ?? "ios";
	const calls: DriverCall[] = [];
	let cursor = 0;
	let alertAnswered = false;
	let swallowed = options.swallowAlertTaps ?? 0;
	const { screens } = options;
	const provider = typeof screens === "function" ? screens : undefined;
	const scripted: Snapshot[] | undefined = typeof screens === "function" ? undefined : [...screens];
	let fixed: Snapshot | undefined;
	let current: Orientation = "portrait";
	let theme: "light" | "dark" = "light";
	let clip = "";
	const wallNow = options.wallNow ?? Date.now;
	let net: NetworkState = { online: true, condition: { kind: "online" }, needsProxy: [] };
	let enrolled = false;
	const running = new Set<string>();
	const installed = new Set<string>();

	const visibleAlert = (): AlertInfo | null => (alertAnswered ? null : findAlert(currentScreen()));

	const currentScreen = (): Snapshot => {
		if (fixed) return fixed;
		if (provider) return provider();
		if (!scripted) throw new Error("fakeDriver: no screens");
		const screen = scripted[Math.min(cursor, scripted.length - 1)];
		if (!screen) throw new Error("fakeDriver: `screens` is empty");
		return screen;
	};

	function run<T>(call: DriverCall, fallback: () => T): Awaited<DriverResult<T>> {
		calls.push(call);
		const override = options.onCall?.(call);
		if (override) {
			if ("error" in override) return { success: false, error: override.error };
			return { success: true, data: override.data as T };
		}
		return { success: true, data: fallback() };
	}

	const app: AppCommands = {
		async launch(bundleId, opts) {
			return run({ method: "app.launch", bundleId, ...(opts && { opts }) }, () => {
				installed.add(bundleId);
				running.add(bundleId);
			});
		},
		async terminate(bundleId) {
			return run({ method: "app.terminate", bundleId }, () => {
				running.delete(bundleId);
			});
		},
		async openUrl(url) {
			return run({ method: "app.openUrl", url }, () => undefined);
		},
		async install(path) {
			return run({ method: "app.install", path }, () => undefined);
		},
		async uninstall(bundleId) {
			return run({ method: "app.uninstall", bundleId }, () => {
				installed.delete(bundleId);
				running.delete(bundleId);
			});
		},
		async isInstalled(bundleId) {
			return run({ method: "app.isInstalled", bundleId }, () => installed.has(bundleId));
		},
		async isRunning(bundleId) {
			return run({ method: "app.isRunning", bundleId }, () => running.has(bundleId));
		},
		async clearData(bundleId, opts) {
			return run({ method: "app.clearData", bundleId, ...(opts && { opts }) }, () => undefined);
		},
	};

	const driver: FakeDriver = {
		platform,
		id: options.id ?? "FAKE-DEVICE",
		capabilities: { ...DEFAULT_CAPABILITIES, ...options.capabilities },
		calls,
		closed: false,
		get screen() {
			return currentScreen();
		},
		advance() {
			cursor += 1;
			alertAnswered = false;
		},
		set(screen) {
			alertAnswered = false;
			if (scripted) scripted[Math.min(cursor, Math.max(scripted.length - 1, 0))] = screen;
			else fixed = screen;
		},
		callsOf<M extends DriverMethod>(method: M) {
			return calls.filter((call): call is Extract<DriverCall, { method: M }> => call.method === method);
		},
		async health() {
			return run<HealthInfo>({ method: "health" }, () => ({
				platform,
				id: driver.id,
				version: "fake",
				transport: platform === "ios" ? "fake-hid" : "adb",
				screen: currentScreen().screen,
			}));
		},
		async snapshot(opts) {
			return run({ method: "snapshot", ...(opts && { opts }) }, currentScreen);
		},
		async elementAtPoint(point, opts) {
			return run({ method: "elementAtPoint", point, ...(opts && { opts }) }, () => hitTest(currentScreen(), point));
		},
		async tap(point, opts) {
			return run({ method: "tap", point, ...(opts && { opts }) }, () => {
				if (!options.answerAlertOnTap) return undefined;
				const screen = currentScreen();
				const hit = hitTest(screen, point);
				const onButton = hit !== null && (findAlert(screen)?.buttons ?? []).some((b) => b === hit);
				if (!onButton || alertAnswered) return undefined;
				if (swallowed > 0) swallowed -= 1;
				else alertAnswered = true;
				return undefined;
			});
		},
		async longPress(point, opts) {
			return run({ method: "longPress", point, ...(opts && { opts }) }, () => undefined);
		},
		async swipe(from, to, opts) {
			return run({ method: "swipe", from, to, ...(opts && { opts }) }, () => undefined);
		},
		async drag(from, to, opts) {
			return run({ method: "drag", from, to, ...(opts && { opts }) }, () => undefined);
		},
		async pinch(center, scale, opts) {
			return run({ method: "pinch", center, scale, ...(opts && { opts }) }, () => undefined);
		},
		async rotate(center, degrees, opts) {
			return run({ method: "rotate", center, degrees, ...(opts && { opts }) }, () => undefined);
		},
		async gesture(paths, opts) {
			const call: DriverCall = { method: "gesture", paths, ...(opts && { opts }) };
			const plan = planGesture(paths, opts, driver.capabilities.maxPointers);
			if (!plan.success) {
				calls.push(call);
				return plan;
			}
			return run(call, () => undefined);
		},
		async typeText(text) {
			return run({ method: "typeText", text }, () => undefined);
		},
		async key(key, modifiers) {
			return run({ method: "key", key, ...(modifiers && { modifiers }) }, () => undefined);
		},
		async pressButton(button) {
			return run({ method: "pressButton", button }, () => undefined);
		},
		async screenshot(opts) {
			return run<{ path?: string; png?: Uint8Array }>({ method: "screenshot", ...(opts && { opts }) }, () =>
				opts?.path ? { path: opts.path } : { png: new Uint8Array() }
			);
		},
		async orientation(set) {
			return run({ method: "orientation", ...(set && { set }) }, () => {
				if (set) current = set;
				return current;
			});
		},
		async settle(opts) {
			return run({ method: "settle", ...(opts && { opts }) }, () => ({ quiet: true, waitedMs: 0 }));
		},
		async alert() {
			return run({ method: "alert" }, () => visibleAlert());
		},
		async appearance(set) {
			return run({ method: "appearance", ...(set && { set }) }, () => {
				if (set) theme = set;
				return theme;
			});
		},
		async clipboard(set) {
			return run({ method: "clipboard", ...(set !== undefined && { set }) }, () => {
				if (set !== undefined) clip = set;
				return clip;
			});
		},
		async network(op) {
			return run({ method: "network", op }, () => {
				net = { online: op.kind !== "offline", condition: op, needsProxy: [] };
				return net;
			});
		},
		async networkFaults(faults) {
			return run({ method: "networkFaults", faults }, () => ({ notes: faultNotes(faults) }));
		},
		async location(op) {
			return run({ method: "location", op }, () => undefined);
		},
		async clock(op) {
			const at = op.kind === "fixed" || op.kind === "frozen" ? Date.parse(op.at) : 0;
			if (Number.isNaN(at)) {
				calls.push({ method: "clock", op });
				return {
					success: false,
					error: driverError("E_BAD_REQUEST", `clock ${op.kind}: not an ISO 8601 date-time`),
				};
			}
			return run({ method: "clock", op }, (): ClockState => {
				const now = wallNow();
				const offsetMs = op.kind === "offset" ? op.ms : op.kind === "fixed" ? at - now : 0;
				return {
					condition: op,
					offsetMs,
					frozen: op.kind === "frozen",
					nowMs: op.kind === "frozen" ? at : now + offsetMs,
				};
			});
		},
		async permissions(grants, opts) {
			return run(
				{ method: "permissions", grants, ...(opts ? { opts } : {}) },
				(): PermissionsState => ({
					bundleId: opts?.bundleId ?? "fake.app",
					applied: Object.entries(grants).map(([permission, state]) => ({
						permission: permission as PermissionName,
						state: state as PermissionState,
					})),
					skipped: [],
				})
			);
		},
		async timezone(tz, opts) {
			return run(
				{ method: "timezone", tz, ...(opts ? { opts } : {}) },
				(): TimezoneState => ({
					...(tz === null ? {} : { timezone: tz }),
				})
			);
		},
		async locale(tag, opts) {
			return run(
				{ method: "locale", tag, ...(opts ? { opts } : {}) },
				(): LocaleState => ({
					...(tag === null ? {} : { locale: tag }),
				})
			);
		},
		async a11y(op) {
			return run(
				{ method: "a11y", op },
				(): A11yState => ({
					applied: op === null ? ["textSize"] : Object.keys(op),
					skipped: [],
					notes: [],
				})
			);
		},
		async battery(op) {
			return run(
				{ method: "battery", op },
				(): BatteryState => ({
					...(op?.level === undefined ? {} : { level: op.level }),
					...(op?.charging === undefined ? {} : { charging: op.charging }),
					cosmetic: false,
				})
			);
		},
		async memoryWarning(opts) {
			return run({ method: "memoryWarning", ...(opts ? { opts } : {}) }, () => undefined);
		},
		async push(payload, opts) {
			return run({ method: "push", payload, ...(opts ? { opts } : {}) }, () => undefined);
		},
		async biometrics(op) {
			return run({ method: "biometrics", op }, () => {
				if (op === "enroll") enrolled = true;
				if (op === "unenroll") enrolled = false;
				return { enrolled, modality: "face" as const };
			});
		},
		app,
		async close() {
			calls.push({ method: "close" });
			driver.closed = true;
		},
	};
	if (options.selectAll) driver.selectAll = async () => run({ method: "selectAll" }, () => undefined);
	if (options.pasteText) driver.pasteText = async (text) => run({ method: "pasteText", text }, () => undefined);
	if (options.setText) driver.setText = async (text) => run({ method: "setText", text }, () => undefined);
	const actions = options.elementActions;
	if (actions !== undefined) {
		driver.pressElement = async (element) => run({ method: "pressElement", element }, () => actions.handled);
		driver.scrollElement = async (direction, within) =>
			run({ method: "scrollElement", direction, ...(within ? { within } : {}) }, () => actions.handled);
	}
	const { alertBackends, frontmost } = options;
	if (alertBackends !== undefined) {
		driver.alertOn = async (backend) =>
			run<AlertInfo | null>({ method: "alertOn", backend }, () =>
				alertBackends.includes(backend) ? visibleAlert() : null
			);
	}
	if (frontmost !== undefined) {
		driver.isFrontmost = async (bundleId) => run({ method: "isFrontmost", bundleId }, () => frontmost() === bundleId);
	}
	if (options.readA11y !== undefined) {
		const read = options.readA11y;
		driver.readA11y = async (snapshot) => run({ method: "readA11y" }, () => read(snapshot));
	}
	if (options.a11yEvents !== undefined) {
		const events = options.a11yEvents;
		driver.a11yEvents = async (since) =>
			run({ method: "a11yEvents", ...(since === undefined ? {} : { since }) }, () => events(since));
	}
	if (options.auditNatively !== undefined) {
		const audit = options.auditNatively;
		driver.auditNatively = async (opts) => {
			calls.push({ method: "auditNatively", ...(opts === undefined ? {} : { options: opts }) });
			return audit(opts);
		};
	}
	if (options.screenReader !== undefined) {
		const reader = options.screenReader;
		driver.screenReaderState = async () =>
			run({ method: "screenReaderState" }, () => reader.state?.() ?? { mode: "real", engine: "talkback" });
		driver.screenReaderNext = async () => run({ method: "screenReaderNext" }, () => reader.next?.());
		driver.screenReaderPrev = async () => run({ method: "screenReaderPrev" }, () => reader.prev?.());
		driver.screenReaderActivate = async () => run({ method: "screenReaderActivate" }, () => reader.activate?.());
		driver.screenReaderFocused = async () => run({ method: "screenReaderFocused" }, () => reader.focused?.());
		driver.screenReaderSpoken = async (since) =>
			run(
				{ method: "screenReaderSpoken", ...(since === undefined ? {} : { since }) },
				() => reader.spoken?.(since) ?? { lines: [], cursor: since ?? 0 }
			);
	}
	return driver;
}

/** Convenience: a failed `DriverResult` payload for `onCall` overrides. */
export function failWith(code: DriverError["code"], message: string = code): { error: DriverError } {
	return { error: driverError(code, message) };
}

/** Narrow a `Result` in tests without optional chaining noise. */
export function unwrap<T>(result: Result<T, DriverError>): T {
	if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.data;
}
