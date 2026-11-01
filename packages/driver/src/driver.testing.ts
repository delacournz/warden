import type {
	ClockCondition,
	HostFault,
	LocationCondition,
	NetworkCondition,
	PermissionName,
	PermissionState,
} from "@delacour/warden-config/conditions.types";
import type { Result } from "@delacour/warden-types/result";
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
	NetworkOptions,
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
import { driverErrors } from "./errors";
import { gestureGeometry } from "./gesture-geometry";
import { networkProxyShaping } from "./network-proxy";
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
	| { method: "pressButton"; button: HardwareButton }
	| { method: "screenshot"; opts?: { path?: string; scale?: number } }
	| { method: "orientation"; set?: Orientation }
	| { method: "settle"; opts?: { quietMs?: number; timeoutMs?: number } }
	| { method: "alert" }
	| { method: "alertOn"; backend: AlertBackend }
	| { method: "isFrontmost"; bundleId: string }
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
};

const DEFAULT_CAPABILITIES: DriverCapabilities = {
	pinch: true,
	maxPointers: 2,
	unicodeText: false,
	nativeSettle: false,
	alerts: true,
	reachability: true,
};

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

/** Builders for fixtures: element specs, snapshots and `onCall` overrides. Use the shared {@link driverFixtures} singleton. */
export class DriverFixtures {
	el(role: Role, options: ElementOptions = {}): ElementSpec {
		return { role, ...options };
	}

	/**
	 * Build a full `Snapshot` from specs: preorder `flat`, path ids (`0.3.1`), depth and `normFrame`.
	 * Specs without a `frame` are laid out as full-width rows, one per preorder index (50 pt pitch).
	 */
	snapshotOf(specs: readonly ElementSpec[], options: SnapshotOptions = {}): Snapshot {
		const screen = options.screen ?? FAKE_SCREEN;
		const platform = options.platform ?? "ios";
		const flat: Element[] = [];
		const elements = specs.map((spec, index) => this.build(flat, screen, spec, `${index}`, 0));
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

	/** Convenience: a failed `DriverResult` payload for `onCall` overrides. */
	failWith(code: DriverError["code"], message: string = code): { error: DriverError } {
		return { error: driverErrors.make(code, message) };
	}

	/** Narrow a `Result` in tests without optional chaining noise. */
	unwrap<T>(result: Result<T, DriverError>): T {
		if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
		return result.data;
	}

	private build(flat: Element[], screen: ScreenInfo, spec: ElementSpec, path: string, depth: number): Element {
		const row = flat.length;
		const frame = spec.frame ?? { x: 0, y: row * ROW_PITCH, width: screen.width, height: ROW_HEIGHT };
		const element: Element = {
			id: path,
			role: spec.role,
			rawType: spec.rawType ?? this.titleCase(spec.role),
			frame,
			normFrame: this.normalise(frame, screen),
			traits: spec.traits ?? [],
			enabled: spec.enabled ?? true,
			depth,
			children: [],
		};
		Object.assign(element, this.optionalFields(spec));
		flat.push(element);
		element.children = (spec.children ?? []).map((child, index) =>
			this.build(flat, screen, child, `${path}.${index}`, depth + 1)
		);
		return element;
	}

	private titleCase(value: string): string {
		return value.charAt(0).toUpperCase() + value.slice(1);
	}

	private normalise(frame: Rect, screen: ScreenInfo): Rect {
		return {
			x: frame.x / screen.width,
			y: frame.y / screen.height,
			width: frame.width / screen.width,
			height: frame.height / screen.height,
		};
	}

	/** Only the optional `Element` fields the spec actually sets (`id` becomes `identifier`). */
	private optionalFields(spec: ElementSpec): Partial<Element> {
		const fields: Partial<Element> = {};
		for (const key of OPTIONAL_KEYS) {
			const value = spec[key];
			if (value !== undefined) Object.assign(fields, { [key]: value });
		}
		if (spec.id !== undefined) fields.identifier = spec.id;
		return fields;
	}
}

export const driverFixtures = new DriverFixtures();

/**
 * A scripted `Driver` that records every call and never touches a device. Optional capabilities (`selectAll`,
 * `setText`, `pasteText`, `alertOn`, `isFrontmost`) exist only when the options ask for them.
 */
export class FakeDriver
	implements
		Driver,
		Partial<SelectsAll>,
		Partial<SetsText>,
		Partial<PastesText>,
		Partial<ReadsAlertOn>,
		Partial<ProbesFrontmost>
{
	readonly platform: Platform;
	readonly id: string;
	readonly capabilities: DriverCapabilities;
	/** every call so far, in order */
	readonly calls: DriverCall[] = [];
	closed = false;
	readonly app: AppCommands;
	selectAll?(): DriverResult<void>;
	setText?(text: string): DriverResult<void>;
	pasteText?(text: string): DriverResult<void>;
	alertOn?(backend: AlertBackend): DriverResult<AlertInfo | null>;
	isFrontmost?(bundleId: string): DriverResult<boolean>;

	private cursor = 0;
	private alertAnswered = false;
	private swallowed: number;
	private readonly provider: (() => Snapshot) | undefined;
	private readonly scripted: Snapshot[] | undefined;
	private fixed: Snapshot | undefined;
	private current: Orientation = "portrait";
	private theme: "light" | "dark" = "light";
	private clip = "";
	private readonly wallNow: () => number;
	private net: NetworkState = { online: true, condition: { kind: "online" }, needsProxy: [] };
	private enrolled = false;
	private readonly running = new Set<string>();
	private readonly installed = new Set<string>();

	constructor(private readonly options: FakeDriverOptions) {
		this.platform = options.platform ?? "ios";
		this.id = options.id ?? "FAKE-DEVICE";
		this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
		this.swallowed = options.swallowAlertTaps ?? 0;
		const { screens } = options;
		this.provider = typeof screens === "function" ? screens : undefined;
		this.scripted = typeof screens === "function" ? undefined : [...screens];
		this.wallNow = options.wallNow ?? Date.now;
		this.app = this.buildApp();
		this.offerCapabilities();
	}

	/** the screen `snapshot()` currently returns */
	get screen(): Snapshot {
		return this.currentScreen();
	}

	/** move to the next scripted screen (clamped to the last) */
	advance = (): void => {
		this.cursor += 1;
		this.alertAnswered = false;
	};

	/** replace the current screen; with a function source this pins a fixed screen */
	set = (screen: Snapshot): void => {
		this.alertAnswered = false;
		if (this.scripted) this.scripted[Math.min(this.cursor, Math.max(this.scripted.length - 1, 0))] = screen;
		else this.fixed = screen;
	};

	/** calls of one method, typed */
	callsOf = <M extends DriverMethod>(method: M): Extract<DriverCall, { method: M }>[] => {
		return this.calls.filter((call): call is Extract<DriverCall, { method: M }> => call.method === method);
	};

	health = async () => {
		return this.run<HealthInfo>({ method: "health" }, () => ({
			platform: this.platform,
			id: this.id,
			version: "fake",
			transport: this.platform === "ios" ? "fake-hid" : "adb",
			screen: this.currentScreen().screen,
		}));
	};

	snapshot = async (opts?: { interactiveOnly?: boolean; backend?: SnapshotBackend }) => {
		return this.run({ method: "snapshot", ...(opts && { opts }) }, () => this.currentScreen());
	};

	elementAtPoint = async (point: Point, opts?: { reachability?: boolean }) => {
		return this.run({ method: "elementAtPoint", point, ...(opts && { opts }) }, () =>
			this.hitTest(this.currentScreen(), point)
		);
	};

	tap = async (point: Point, opts?: { count?: number; durationMs?: number }) => {
		return this.run({ method: "tap", point, ...(opts && { opts }) }, () => {
			if (!this.options.answerAlertOnTap) return undefined;
			const screen = this.currentScreen();
			const hit = this.hitTest(screen, point);
			const onButton = hit !== null && (this.findAlert(screen)?.buttons ?? []).some((b) => b === hit);
			if (!onButton || this.alertAnswered) return undefined;
			if (this.swallowed > 0) this.swallowed -= 1;
			else this.alertAnswered = true;
			return undefined;
		});
	};

	longPress = async (point: Point, opts?: { durationMs?: number }) => {
		return this.run({ method: "longPress", point, ...(opts && { opts }) }, () => undefined);
	};

	swipe = async (from: Point, to: Point, opts?: { durationMs?: number; momentum?: boolean }) => {
		return this.run({ method: "swipe", from, to, ...(opts && { opts }) }, () => undefined);
	};

	drag = async (from: Point, to: Point, opts?: { pressMs?: number; durationMs?: number; releaseMs?: number }) => {
		return this.run({ method: "drag", from, to, ...(opts && { opts }) }, () => undefined);
	};

	pinch = async (center: Point, scale: number, opts?: TwoFingerOptions) => {
		return this.run({ method: "pinch", center, scale, ...(opts && { opts }) }, () => undefined);
	};

	rotate = async (center: Point, degrees: number, opts?: TwoFingerOptions) => {
		return this.run({ method: "rotate", center, degrees, ...(opts && { opts }) }, () => undefined);
	};

	gesture = async (paths: readonly TouchPath[], opts?: GestureOptions) => {
		const call: DriverCall = { method: "gesture", paths, ...(opts && { opts }) };
		const plan = gestureGeometry.planGesture(paths, opts, this.capabilities.maxPointers);
		if (!plan.success) {
			this.calls.push(call);
			return plan;
		}
		return this.run(call, () => undefined);
	};

	typeText = async (text: string) => {
		return this.run({ method: "typeText", text }, () => undefined);
	};

	key = async (key: KeyName, modifiers?: readonly Modifier[]) => {
		return this.run({ method: "key", key, ...(modifiers && { modifiers }) }, () => undefined);
	};

	pressButton = async (button: HardwareButton) => {
		return this.run({ method: "pressButton", button }, () => undefined);
	};

	screenshot = async (opts?: { path?: string; scale?: number }) => {
		return this.run<{ path?: string; png?: Uint8Array }>({ method: "screenshot", ...(opts && { opts }) }, () =>
			opts?.path ? { path: opts.path } : { png: new Uint8Array() }
		);
	};

	orientation = async (set?: Orientation) => {
		return this.run({ method: "orientation", ...(set && { set }) }, () => {
			if (set) this.current = set;
			return this.current;
		});
	};

	settle = async (opts?: { quietMs?: number; timeoutMs?: number }) => {
		return this.run({ method: "settle", ...(opts && { opts }) }, () => ({ quiet: true, waitedMs: 0 }));
	};

	alert = async () => {
		return this.run({ method: "alert" }, () => this.visibleAlert());
	};

	appearance = async (set?: "light" | "dark") => {
		return this.run({ method: "appearance", ...(set && { set }) }, () => {
			if (set) this.theme = set;
			return this.theme;
		});
	};

	clipboard = async (set?: string) => {
		return this.run({ method: "clipboard", ...(set !== undefined && { set }) }, () => {
			if (set !== undefined) this.clip = set;
			return this.clip;
		});
	};

	network = async (op: NetworkCondition, _opts?: NetworkOptions) => {
		return this.run({ method: "network", op }, () => {
			this.net = { online: op.kind !== "offline", condition: op, needsProxy: [] };
			return this.net;
		});
	};

	networkFaults = async (faults: readonly HostFault[]) => {
		return this.run({ method: "networkFaults", faults }, () => ({ notes: networkProxyShaping.faultNotes(faults) }));
	};

	location = async (op: LocationCondition) => {
		return this.run({ method: "location", op }, () => undefined);
	};

	clock = async (op: ClockCondition, _opts?: NetworkOptions) => {
		const at = op.kind === "fixed" || op.kind === "frozen" ? Date.parse(op.at) : 0;
		if (Number.isNaN(at)) {
			this.calls.push({ method: "clock", op });
			return driverErrors.err("E_BAD_REQUEST", `clock ${op.kind}: not an ISO 8601 date-time`);
		}
		return this.run({ method: "clock", op }, (): ClockState => {
			const now = this.wallNow();
			const offsetMs = op.kind === "offset" ? op.ms : op.kind === "fixed" ? at - now : 0;
			return {
				condition: op,
				offsetMs,
				frozen: op.kind === "frozen",
				nowMs: op.kind === "frozen" ? at : now + offsetMs,
			};
		});
	};

	permissions = async (grants: PermissionGrants, opts?: SettingOptions) => {
		return this.run(
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
	};

	timezone = async (tz: string | null, opts?: { previous?: string }) => {
		return this.run(
			{ method: "timezone", tz, ...(opts ? { opts } : {}) },
			(): TimezoneState => ({
				...(tz === null ? {} : { timezone: tz }),
			})
		);
	};

	locale = async (tag: string | null, opts?: SettingOptions) => {
		return this.run(
			{ method: "locale", tag, ...(opts ? { opts } : {}) },
			(): LocaleState => ({
				...(tag === null ? {} : { locale: tag }),
			})
		);
	};

	a11y = async (op: A11yOp | null) => {
		return this.run(
			{ method: "a11y", op },
			(): A11yState => ({
				applied: op === null ? ["textSize"] : Object.keys(op),
				skipped: [],
				notes: [],
			})
		);
	};

	battery = async (op: BatteryOp | null) => {
		return this.run(
			{ method: "battery", op },
			(): BatteryState => ({
				...(op?.level === undefined ? {} : { level: op.level }),
				...(op?.charging === undefined ? {} : { charging: op.charging }),
				cosmetic: false,
			})
		);
	};

	memoryWarning = async (opts?: SettingOptions) => {
		return this.run({ method: "memoryWarning", ...(opts ? { opts } : {}) }, () => undefined);
	};

	push = async (payload: PushPayload, opts?: SettingOptions) => {
		return this.run({ method: "push", payload, ...(opts ? { opts } : {}) }, () => undefined);
	};

	biometrics = async (op: BiometricOp) => {
		return this.run({ method: "biometrics", op }, () => {
			if (op === "enroll") this.enrolled = true;
			if (op === "unenroll") this.enrolled = false;
			return { enrolled: this.enrolled, modality: "face" as const };
		});
	};

	close = async (): Promise<void> => {
		this.calls.push({ method: "close" });
		this.closed = true;
	};

	private buildApp(): AppCommands {
		return {
			launch: async (bundleId, opts) =>
				this.run({ method: "app.launch", bundleId, ...(opts && { opts }) }, () => {
					this.installed.add(bundleId);
					this.running.add(bundleId);
				}),
			terminate: async (bundleId) =>
				this.run({ method: "app.terminate", bundleId }, () => {
					this.running.delete(bundleId);
				}),
			openUrl: async (url) => this.run({ method: "app.openUrl", url }, () => undefined),
			install: async (path) => this.run({ method: "app.install", path }, () => undefined),
			uninstall: async (bundleId) =>
				this.run({ method: "app.uninstall", bundleId }, () => {
					this.installed.delete(bundleId);
					this.running.delete(bundleId);
				}),
			isInstalled: async (bundleId) =>
				this.run({ method: "app.isInstalled", bundleId }, () => this.installed.has(bundleId)),
			isRunning: async (bundleId) => this.run({ method: "app.isRunning", bundleId }, () => this.running.has(bundleId)),
			clearData: async (bundleId, opts) =>
				this.run({ method: "app.clearData", bundleId, ...(opts && { opts }) }, () => undefined),
		};
	}

	/** Adds the optional capabilities the options ask for. */
	private offerCapabilities(): void {
		const { options } = this;
		if (options.selectAll) this.selectAll = async () => this.run({ method: "selectAll" }, () => undefined);
		if (options.pasteText) this.pasteText = async (text) => this.run({ method: "pasteText", text }, () => undefined);
		if (options.setText) this.setText = async (text) => this.run({ method: "setText", text }, () => undefined);
		const { alertBackends, frontmost } = options;
		if (alertBackends !== undefined) {
			this.alertOn = async (backend) =>
				this.run<AlertInfo | null>({ method: "alertOn", backend }, () =>
					alertBackends.includes(backend) ? this.visibleAlert() : null
				);
		}
		if (frontmost !== undefined) {
			this.isFrontmost = async (bundleId) =>
				this.run({ method: "isFrontmost", bundleId }, () => frontmost() === bundleId);
		}
	}

	private visibleAlert(): AlertInfo | null {
		return this.alertAnswered ? null : this.findAlert(this.currentScreen());
	}

	private currentScreen(): Snapshot {
		if (this.fixed) return this.fixed;
		if (this.provider) return this.provider();
		if (!this.scripted) throw new Error("fakeDriver: no screens");
		const screen = this.scripted[Math.min(this.cursor, this.scripted.length - 1)];
		if (!screen) throw new Error("fakeDriver: `screens` is empty");
		return screen;
	}

	private run<T>(call: DriverCall, fallback: () => T): Awaited<DriverResult<T>> {
		this.calls.push(call);
		const override = this.options.onCall?.(call);
		if (override) {
			if ("error" in override) return { success: false, error: override.error };
			return { success: true, data: override.data as T };
		}
		return { success: true, data: fallback() };
	}

	private area(rect: Rect): number {
		return rect.width * rect.height;
	}

	private contains(rect: Rect, point: Point): boolean {
		return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
	}

	/** Smallest element under the point; later (deeper / later in preorder) wins ties. */
	private hitTest(snapshot: Snapshot, point: Point): Element | null {
		let best: Element | null = null;
		for (const element of snapshot.flat) {
			if (element.hidden || !this.contains(element.frame, point)) continue;
			if (!best || this.area(element.frame) <= this.area(best.frame)) best = element;
		}
		return best;
	}

	private findAlert(snapshot: Snapshot): AlertInfo | null {
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
}
