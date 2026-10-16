import type { Result } from "@delacour/warden-types/result";
import type { AlertBackend, ProbesFrontmost, ReadsAlertOn } from "./alerts";
import type {
	AlertInfo,
	AppCommands,
	Driver,
	DriverCapabilities,
	DriverError,
	DriverResult,
	Element,
	HardwareButton,
	HealthInfo,
	KeyName,
	LaunchOptions,
	Modifier,
	Orientation,
	Platform,
	Point,
	Rect,
	Role,
	ScreenInfo,
	Snapshot,
	SnapshotBackend,
} from "./driver.types";
import { driverError } from "./errors";

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
	| { method: "pinch"; center: Point; scale: number; opts?: { durationMs?: number; radius?: number } }
	| { method: "typeText"; text: string }
	| { method: "key"; key: KeyName; modifiers?: readonly Modifier[] }
	| { method: "pressButton"; button: HardwareButton }
	| { method: "screenshot"; opts?: { path?: string; scale?: number } }
	| { method: "orientation"; set?: Orientation }
	| { method: "settle"; opts?: { quietMs?: number; timeoutMs?: number } }
	| { method: "alert" }
	| { method: "alertOn"; backend: AlertBackend }
	| { method: "isFrontmost"; bundleId: string }
	| { method: "appearance"; set?: "light" | "dark" }
	| { method: "clipboard"; set?: string }
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
	capabilities?: Partial<DriverCapabilities>;
	/** inspect every call (after it is recorded); return an override to fail it or fake its result */
	onCall?: (call: DriverCall) => FakeOverride | undefined;
	/**
	 * Offer the optional `alertOn` capability (`driver/alerts.ts`); the listed readers see the screen's alert, the
	 * others report none. Absent = a driver with only `alert()`.
	 */
	alertBackends?: readonly AlertBackend[];
	/** Offer the optional `isFrontmost` capability: the bundle id of the app in front (evaluated per call). */
	frontmost?: () => string | undefined;
};

export type FakeDriver = Driver &
	Partial<ReadsAlertOn & ProbesFrontmost> & {
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
	const { screens } = options;
	const provider = typeof screens === "function" ? screens : undefined;
	const scripted: Snapshot[] | undefined = typeof screens === "function" ? undefined : [...screens];
	let fixed: Snapshot | undefined;
	let current: Orientation = "portrait";
	let theme: "light" | "dark" = "light";
	let clip = "";
	const running = new Set<string>();
	const installed = new Set<string>();

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
		},
		set(screen) {
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
			return run({ method: "tap", point, ...(opts && { opts }) }, () => undefined);
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
			return run({ method: "alert" }, () => findAlert(currentScreen()));
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
		app,
		async close() {
			calls.push({ method: "close" });
			driver.closed = true;
		},
	};
	const { alertBackends, frontmost } = options;
	if (alertBackends !== undefined) {
		driver.alertOn = async (backend) =>
			run<AlertInfo | null>({ method: "alertOn", backend }, () =>
				alertBackends.includes(backend) ? findAlert(currentScreen()) : null
			);
	}
	if (frontmost !== undefined) {
		driver.isFrontmost = async (bundleId) => run({ method: "isFrontmost", bundleId }, () => frontmost() === bundleId);
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
