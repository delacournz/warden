import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LatLon } from "@delacour/warden-config/conditions.types";
import { androidBiometrics } from "@delacour/warden-core/golden/android-biometrics";
import { BaseDriver, type BaseDriverOptions } from "@delacour/warden-driver/base-driver";
import type { ClockRecorder } from "@delacour/warden-driver/clock-recorder";
import type { ConditionSink } from "@delacour/warden-driver/conditions/condition-events";
import type { TickerClock } from "@delacour/warden-driver/conditions/route-ticker";
import type {
	AlertInfo,
	BiometricState,
	Driver,
	DriverCapabilities,
	DriverError,
	DriverResult,
	Element,
	HardwareButton,
	HealthInfo,
	KeyName,
	Logger,
	Modifier,
	Orientation,
	Point,
	ScreenInfo,
	Snapshot,
} from "@delacour/warden-driver/driver.types";
import { driverErrors } from "@delacour/warden-driver/errors";
import { DEFAULT_RADIUS, type GesturePlan, gestureGeometry } from "@delacour/warden-driver/gesture-geometry";
import type { NetworkProxyPort } from "@delacour/warden-driver/network-proxy";
import type { DetectsAlerts } from "@delacour/warden-driver/observation-cache";
import { physicalConditions } from "@delacour/warden-driver/physical-conditions";
import { settler } from "@delacour/warden-driver/settle";
import { spanDetails } from "@delacour/warden-driver/trace/span-detail";
import type { RepeatingKeys, SelectsAll, SetsText } from "@delacour/warden-driver/typing";
import type { Exec } from "@delacour/warden-runtime/exec";
import { type AdbSession, adbSessions, type SpawnAdb } from "./adb-session";
import { androidAlert } from "./android-alert";
import { AndroidAnimations, type AnimationGuard } from "./android-animations";
import { AndroidApp } from "./android-app";
import {
	androidArgv,
	DRAG_STEPS,
	GESTURE_LINE_MAX_MOVES,
	MOTIONEVENT_MIN_SDK,
	SELECT_ALL_MIN_SDK,
	UNENROLLED_FINGER_ID,
} from "./android-argv";
import { AndroidClock } from "./android-clock";
import { androidDevice, type BootInfo, type Clock, realClock } from "./android-device";
import { Dumper, type DumpRoute } from "./android-dump";
import { AndroidNetwork } from "./android-network";
import { androidPhone, type SettingsGuard } from "./android-phone";
import { AndroidSettings } from "./android-settings";
import { type AndroidDeviceState, type AndroidStateStore, androidState } from "./android-state";
import { UiadBackendService, type UiadOptions } from "./uiad-backend";
import { UIAD_MIN_SDK } from "./uiad-device";
import { type UiadOps, UiadOpsService } from "./uiad-ops";
import { UiautomatorParseError, uiautomatorParser } from "./uiautomator";

/** Binary-safe host process runner (screenshots); `Exec` is text-only. */
export type ExecBinary = (
	argv: readonly string[],
	opts?: { timeoutMs?: number }
) => Promise<{ exitCode: number; stdout: Uint8Array }>;

/** Default {@link ExecBinary}: `Bun.spawn`, stderr dropped, never throws (a spawn failure is exit 127). */
class BunExecBinary {
	readonly run: ExecBinary = async (argv, opts = {}) => {
		try {
			const proc = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: opts.timeoutMs });
			const [bytes, exitCode] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
			return { exitCode, stdout: new Uint8Array(bytes) };
		} catch {
			return { exitCode: 127, stdout: new Uint8Array() };
		}
	};
}

export const bunExecBinary: ExecBinary = new BunExecBinary().run;

export type AndroidDriverOptions = {
	serial: string;
	/** path of the `adb` binary (`androidTools(env).adb`) */
	adb: string;
	/** text-only host runner (`bunExec` in production): `adb install`, the `exec-out` dump route */
	exec: Exec;
	/** override how the resident shell is spawned (tests) */
	spawn?: SpawnAdb;
	log?: Logger;
	/** the lease's shaping proxy: loss and per-host faults route through it (`createAndroidNetwork`); without it loss stays in `needsProxy` */
	networkProxy?: NetworkProxyPort;
	/** told about every successful `clock` op, so the lease records the `clock` area (`leaseClockRecorder`) */
	clockRecorder?: ClockRecorder;
	/** skip `wm size`/`wm density` */
	screen?: ScreenInfo;
	/** binary runner for screenshots, default {@link bunExecBinary} */
	execBinary?: ExecBinary;
	/** injectable clock for boot polling and settle (default real time) */
	clock?: Clock;
	/** the dump route that worked last time (a `warden ui` call is a fresh process; skips probing the others) */
	dumpRoute?: DumpRoute;
	/** told when a dump route is first found to work or changes (`state`, when given, saves it too) */
	onDumpRoute?: (route: DumpRoute) => void;
	/**
	 * What warden remembers about this device between processes (`$WARDEN_HOME/android/<serial>.json`): the dump
	 * route that worked, and the animation scales to put back when the driver closes. Omit it and nothing is saved.
	 */
	state?: AndroidStateStore;
	/** the app under test: `app.openUrl` is addressed to it (`am start -p`), so no other app or chooser takes the link */
	appPackage?: string;
	/**
	 * Packages besides `appPackage` that warden installed on this device (the `installs` table). On a physical phone
	 * only these may be uninstalled or have their data cleared; anything else is `E_REFUSED` (`physical_protected`).
	 */
	ownedPackages?: readonly string[];
	/** how long to wait for `sys.boot_completed`, default 30 s */
	bootTimeoutMs?: number;
	/**
	 * Use the resident UiAutomation server (`warden-uiad`) for snapshots, settle and input, with `uiautomator dump`
	 * and `input` as the fallback for any call it cannot do. Off unless given: `true` for the defaults, or the seams
	 * (a fake spawn, a fake dex push) a test replaces. API 26 and up only.
	 */
	uiad?: boolean | UiadOptions;
	/** pacing of in-process location routes (default real time); tests pass a fake */
	tickerClock?: TickerClock;
	/** told about every network flap transition (the `condition` events of `results.jsonl`) */
	conditionSink?: ConditionSink;
};

/** What the dump-and-`input` driver reports; with the server on, `unicodeText` and `nativeSettle` are true. */
const CAPABILITIES: DriverCapabilities = {
	pinch: false,
	maxPointers: 0,
	unicodeText: false,
	nativeSettle: false,
	alerts: true,
	reachability: true,
};

/** `uiautomator dump` waits for this long without accessibility events before it reads the screen. */
const DUMP_IDLE_MS = 1_000;
/** ...and stops waiting after this long, dumping a screen that never went idle. */
const DUMP_IDLE_TIMEOUT_MS = 10_000;
/** uiautomator fails transiently (`null root node`) while a window is opening; a few quick retries ride it out. */
const SNAPSHOT_ATTEMPTS = 3;
const INPUT_TEXT_BASE_MS = 10_000;
const INPUT_TEXT_PIECE_MS = 8_000;
const SNAPSHOT_RETRY_MS = 400;
const SCREENSHOT_TIMEOUT_MS = 10_000;
const DRAG_PRESS_MS = 500;
const DRAG_MOVE_MS = 600;
/** worst case for one `input motionevent` process start under load */
const DRAG_PROCESS_BUDGET_MS = 3_000;
const GEO_FIX_MS = 10_000;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

const unit = { success: true as const, data: undefined };

/** Deepest hittable element containing `point` (later in preorder wins ties: drawn on top); else deepest any. */
class ElementHitTest {
	at(flat: readonly Element[], point: Point): Element | null {
		const inside = flat.filter(
			(e) =>
				point.x >= e.frame.x &&
				point.x < e.frame.x + e.frame.width &&
				point.y >= e.frame.y &&
				point.y < e.frame.y + e.frame.height
		);
		return this.deepest(inside.filter((e) => e.hittable)) ?? this.deepest(inside) ?? null;
	}

	private deepest(list: readonly Element[]): Element | undefined {
		return list.reduce<Element | undefined>(
			(best, e) => (best === undefined || e.depth >= best.depth ? e : best),
			undefined
		);
	}
}

const elementHitTest = new ElementHitTest();

/** What `AndroidDrivers.open` learned about the device that the driver needs: its API level, saved route, animation guard. */
type DeviceFacts = {
	sdk: number | undefined;
	savedRoute: DumpRoute | undefined;
	/** the `warden-uiad` build a past process found cannot run on this device */
	savedUiadUnsupported: string | undefined;
	animations: AnimationGuard;
	/** a physical phone's rotation / night-mode guard; undefined on an emulator */
	settings: SettingsGuard | undefined;
	physical: boolean;
};

/**
 * The resident server's ops, when the caller asked for it and the device runs an API level it is built for;
 * `undefined` means the dump and `input` do everything. A start that can never work on this device is written to
 * the state file (`uiadUnsupported`) so the next process does not try it.
 */
class UiadOpener {
	open(input: {
		options: AndroidDriverOptions;
		session: AdbSession;
		baseScreen: ScreenInfo;
		clock: Clock;
		facts: DeviceFacts;
		saving: Promise<void>[];
	}): UiadOps | undefined {
		const { options, session, baseScreen, clock, facts, saving } = input;
		const { sdk } = facts;
		const asked = options.uiad === true ? {} : options.uiad || undefined;
		if (asked === undefined || sdk === undefined || sdk < UIAD_MIN_SDK) return undefined;
		const { serial, adb, log, state } = options;
		const backend = new UiadBackendService({
			session,
			adb,
			serial,
			clock,
			options: asked,
			...(log ? { log } : {}),
			...(facts.savedUiadUnsupported !== undefined ? { unsupportedBuild: facts.savedUiadUnsupported } : {}),
			onUnsupported: (buildId) => {
				if (state) saving.push(state.update(serial, androidState.patchFor(sdk, { uiadUnsupported: buildId })));
			},
		});
		return new UiadOpsService({ backend, baseScreen, clock, ...(log ? { log } : {}) });
	}
}

/** The slice of the driver options the shared {@link BaseDriver} takes. */
class BaseDriverOptionsFactory {
	of(options: AndroidDriverOptions, time: Clock): BaseDriverOptions {
		const { log, tickerClock, conditionSink, clockRecorder } = options;
		return {
			now: time.now,
			sleep: time.sleep,
			...(log ? { log } : {}),
			...(tickerClock ? { tickerClock } : {}),
			...(conditionSink ? { conditionSink } : {}),
			...(clockRecorder ? { clockRecorder } : {}),
		};
	}
}

const baseDriverOptions = new BaseDriverOptionsFactory();

/**
 * Android `Driver`: one resident `adb shell` (inputs, `am`, `pm`, dumps), host `adb` for install and
 * `exec-out` (binary screenshots never touch the session). `settle` is implemented here over snapshots (one dump,
 * or `settleByHash` for a long quiet window), so the TS layer needs no fallback (`nativeSettle: false`). The
 * animation scales it turns off on open are put back by `close`. Built by {@link AndroidDrivers.open}.
 *
 * The driver ops are arrow-function properties (own, enumerable, detachable) so a wrapper may spread or proxy them.
 */
export class AndroidDriver
	extends BaseDriver
	implements Driver, RepeatingKeys, DetectsAlerts, Partial<SelectsAll>, Partial<SetsText>
{
	readonly platform = "android" as const;
	readonly id: string;
	declare readonly networkFaults: Driver["networkFaults"];
	declare readonly permissions: Driver["permissions"];
	declare readonly timezone: Driver["timezone"];
	declare readonly locale: Driver["locale"];
	declare readonly a11y: Driver["a11y"];
	declare readonly battery: Driver["battery"];
	declare readonly memoryWarning: Driver["memoryWarning"];
	declare readonly push: Driver["push"];
	readonly app: Driver["app"];
	readonly selectAll?: SelectsAll["selectAll"];
	readonly setText?: SetsText["setText"];

	private readonly serial: string;
	private readonly adb: string;
	private readonly sdk: number | undefined;
	private readonly dumper: Dumper;
	private readonly uiad: UiadOps | undefined;
	private readonly net: AndroidNetwork;
	private readonly radius: number;

	constructor(
		private readonly options: AndroidDriverOptions,
		private readonly session: AdbSession,
		private readonly baseScreen: ScreenInfo,
		private readonly time: Clock,
		private readonly execBinary: ExecBinary,
		private readonly facts: DeviceFacts
	) {
		super(baseDriverOptions.of(options, time));
		const { serial, adb, exec, log } = options;
		const sdk = facts.sdk;
		this.id = serial;
		this.serial = serial;
		this.adb = adb;
		this.sdk = sdk;
		this.radius = DEFAULT_RADIUS * baseScreen.scale;
		const initialRoute = options.dumpRoute ?? facts.savedRoute;
		this.dumper = new Dumper({
			session,
			exec,
			adb,
			serial,
			...(sdk !== undefined ? { sdk } : {}),
			...(log ? { log } : {}),
			...(initialRoute ? { initialRoute } : {}),
			onRoute: (route) => {
				options.onDumpRoute?.(route);
				if (options.state)
					this.saving.push(options.state.update(serial, androidState.patchFor(sdk, { dumpRoute: route })));
			},
		});
		this.uiad = new UiadOpener().open({ options, session, baseScreen, clock: time, facts, saving: this.saving });
		this.net = new AndroidNetwork({
			session,
			exec,
			adb,
			serial,
			clock: time,
			...(options.networkProxy ? { proxy: options.networkProxy } : {}),
		});
		if (this.uiad !== undefined || (sdk !== undefined && sdk >= SELECT_ALL_MIN_SDK)) this.selectAll = this.runSelectAll;
		if (this.uiad !== undefined) this.setText = this.runSetText;
		this.app = new AndroidApp({
			session,
			exec,
			adb,
			serial,
			...(log ? { log } : {}),
			...(options.appPackage ? { appPackage: options.appPackage } : {}),
			...(facts.physical ? { physical: true, ownedPackages: options.ownedPackages ?? [] } : {}),
		});
		Object.assign(
			this,
			{ networkFaults: this.net.networkFaults },
			new AndroidSettings({
				session,
				serial,
				...(options.appPackage ? { appPackage: options.appPackage } : {}),
			}).ops(),
			facts.physical ? physicalConditions.ops(`physical Android device ${serial}`) : {}
		);
	}

	get capabilities(): DriverCapabilities {
		return this.uiad?.enabled()
			? { ...CAPABILITIES, pinch: true, maxPointers: 2, unicodeText: true, nativeSettle: true }
			: { ...CAPABILITIES, maxPointers: this.maxPointers() };
	}

	readonly health: Driver["health"] = async () => {
		const [release, sdk, model] = await Promise.all(
			["ro.build.version.release", "ro.build.version.sdk", "ro.product.model"].map((k) =>
				this.session.run(androidArgv.shellCommand(androidArgv.getpropArgv(k)))
			)
		);
		const text = (r: typeof release): string => (r?.success ? r.data.stdout.trim() : "");
		const info: HealthInfo = {
			platform: "android",
			id: this.serial,
			version: `Android ${text(release)} (sdk ${text(sdk)})`,
			transport: "adb",
			screen: this.baseScreen,
			detail: { model: text(model), dumpRoute: this.dumper.route() ?? null, uiad: this.uiad?.status() ?? "off" },
		};
		return { success: true, data: info };
	};

	readonly snapshot: Driver["snapshot"] = async (opts) => {
		if (opts?.backend !== undefined && opts.backend !== "uiautomator") {
			return driverErrors.err("E_UNSUPPORTED", `Android only has the uiautomator backend, not ${opts.backend}`);
		}
		const taken = await this.takeSnapshot();
		if (!taken.success || !opts?.interactiveOnly) return taken;
		return { success: true, data: { ...taken.data, ...uiautomatorParser.interactiveFilter(taken.data.elements) } };
	};

	/**
	 * A hit-test is a whole dump: it never reuses an earlier snapshot. Its one caller, the read-back after a `fill`,
	 * needs each read to be a new look at the field (a stale one defeats the check that the value held); screen reads
	 * that can share a snapshot go through the runtime's observation cache (`observation-cache.ts`) instead.
	 */
	readonly elementAtPoint: Driver["elementAtPoint"] = async (point) => {
		const snap = await this.takeSnapshot();
		return snap.success ? { success: true, data: elementHitTest.at(snap.data.flat, point) } : snap;
	};

	readonly tap: Driver["tap"] = async (point, opts) => {
		const t0 = this.time.now();
		const count = Math.max(1, opts?.count ?? 1);
		const once = opts?.durationMs ? androidArgv.longPressArgv(point, opts.durationMs) : androidArgv.tapArgv(point);
		const res =
			(await this.uiad?.tap(point, { count, ...(opts?.durationMs ? { durationMs: opts.durationMs } : {}) })) ??
			(await this.input(Array.from({ length: count }, () => androidArgv.shellCommand(once)).join("; ")));
		this.options.log?.(`tap ${Math.round(point.x)},${Math.round(point.y)} x${count} in ${this.time.now() - t0}ms`);
		return res;
	};

	readonly longPress: Driver["longPress"] = async (point, opts) =>
		(await this.uiad?.longPress(point, opts?.durationMs)) ??
		this.input(androidArgv.shellCommand(androidArgv.longPressArgv(point, opts?.durationMs)));

	readonly swipe: Driver["swipe"] = async (from, to, opts) =>
		(await this.uiad?.swipe(from, to, opts?.durationMs)) ??
		this.input(androidArgv.shellCommand(androidArgv.swipeArgv(from, to, opts?.durationMs)));

	readonly typeText: Driver["typeText"] = async (text) => {
		const fast = text === "" ? undefined : await this.uiad?.typeText(text);
		if (fast !== undefined) return fast;
		const argvs = androidArgv.textArgvs(text);
		if (!argvs.success) return argvs;
		if (argvs.data.length === 0) return unit;
		// every `input text` is its own JVM start (hundreds of ms, seconds under load): budget per piece
		return this.input(
			argvs.data.map((argv) => androidArgv.shellCommand(argv)).join(" && "),
			INPUT_TEXT_BASE_MS + INPUT_TEXT_PIECE_MS * argvs.data.length
		);
	};

	readonly key: Driver["key"] = async (name: KeyName, modifiers: readonly Modifier[] = []) => {
		const code = androidArgv.keyNameKeycode(name);
		if (modifiers.length === 0) {
			return (await this.uiad?.key(code)) ?? this.input(androidArgv.shellCommand(androidArgv.keyeventArgv(code)));
		}
		const res = await this.session.run(
			androidArgv.shellCommand(
				androidArgv.keycombinationArgv([...modifiers.map((m) => androidArgv.modifierKeycode(m)), code])
			)
		);
		if (!res.success) return res;
		return res.data.exitCode === 0
			? unit
			: driverErrors.err("E_UNSUPPORTED", "key modifiers need Android 13+ (`input keycombination`)");
	};

	/** See `RepeatingKeys`: N presses in one round trip (`input keyevent 67 67 67 …`). */
	readonly pressKeyRepeat: RepeatingKeys["pressKeyRepeat"] = async (name, times) => {
		const argvs = androidArgv.keyRepeatArgvs(androidArgv.keyNameKeycode(name), times);
		if (argvs.length === 0) return unit;
		const fast = await this.uiad?.key(androidArgv.keyNameKeycode(name), Math.floor(times));
		if (fast !== undefined) return fast;
		return this.input(
			argvs.map((argv) => androidArgv.shellCommand(argv)).join(" && "),
			INPUT_TEXT_BASE_MS + INPUT_TEXT_PIECE_MS * argvs.length
		);
	};

	/**
	 * Hold-then-move on sdk 26+ (`input motionevent` DOWN, interpolated MOVEs, UP, one shell line); older images
	 * and an unreadable sdk fall back to a long `input swipe` (no hold).
	 */
	readonly drag: Driver["drag"] = async (from, to, opts) => {
		const timing = {
			pressMs: opts?.pressMs ?? DRAG_PRESS_MS,
			durationMs: opts?.durationMs ?? DRAG_MOVE_MS,
			releaseMs: opts?.releaseMs ?? 0,
		};
		const fast = await this.uiad?.drag(from, to, timing);
		if (fast !== undefined) return fast;
		const total = timing.pressMs + timing.durationMs + timing.releaseMs;
		if (this.sdk === undefined || this.sdk < MOTIONEVENT_MIN_SDK) {
			return this.input(androidArgv.shellCommand(androidArgv.swipeArgv(from, to, total)));
		}
		return this.input(
			androidArgv.dragMotionCommand(from, to, timing),
			INPUT_TEXT_BASE_MS + total + (DRAG_STEPS + 2) * DRAG_PROCESS_BUDGET_MS
		);
	};

	readonly pinch: Driver["pinch"] = async (center, scale, opts) => {
		const plan = gestureGeometry.pinchPlan(center, scale, opts, this.radius);
		return plan.success ? this.runGesture(plan.data) : plan;
	};

	readonly rotate: Driver["rotate"] = async (center, degrees, opts) => {
		const plan = gestureGeometry.rotatePlan(center, degrees, opts, this.radius);
		return plan.success ? this.runGesture(plan.data) : plan;
	};

	readonly gesture: Driver["gesture"] = async (paths, opts) => {
		const plan = gestureGeometry.planGesture(paths, opts, this.maxPointers());
		return plan.success ? this.runGesture(plan.data) : plan;
	};

	readonly pressButton: Driver["pressButton"] = async (button: HardwareButton) => {
		const code = androidArgv.buttonKeycode(button);
		if (code === undefined) return driverErrors.err("E_UNSUPPORTED", `Android has no ${button} button`);
		return (await this.uiad?.key(code)) ?? this.input(androidArgv.shellCommand(androidArgv.keyeventArgv(code)));
	};

	readonly screenshot: Driver["screenshot"] = async (opts) => {
		const res = await this.execBinary(androidArgv.screencapArgv(this.adb, this.serial), {
			timeoutMs: SCREENSHOT_TIMEOUT_MS,
		});
		if (res.exitCode !== 0 || !PNG_MAGIC.every((b, i) => res.stdout[i] === b)) {
			return driverErrors.err(
				"E_IO",
				`screencap on ${this.serial} gave no PNG (exit ${res.exitCode}, ${res.stdout.length} bytes)`
			);
		}
		if (!opts?.path) return { success: true, data: { png: res.stdout } };
		try {
			await mkdir(dirname(opts.path), { recursive: true });
			await writeFile(opts.path, res.stdout);
		} catch (error) {
			return driverErrors.err(
				"E_IO",
				`cannot write ${opts.path}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
		return { success: true, data: { path: opts.path } };
	};

	readonly orientation: Driver["orientation"] = async (set?: Orientation) => {
		if (set) {
			const saved = await this.facts.settings?.beforeRotate();
			if (saved && !saved.success) return saved;
			for (const argv of androidArgv.rotationArgvs(androidDevice.orientationToRotation(set))) {
				const res = await this.input(androidArgv.shellCommand(argv));
				if (!res.success) return res;
			}
			return { success: true, data: set };
		}
		const res = await this.session.run(androidArgv.shellCommand(androidArgv.userRotationArgv()));
		if (!res.success) return res;
		const n = Number.parseInt(res.data.stdout.trim(), 10);
		return { success: true, data: androidDevice.rotationToOrientation(Number.isNaN(n) ? 0 : n) };
	};

	/**
	 * `uiautomator dump` waits for a second without accessibility events before it reads, so one dump is already
	 * "quiet for 1 s": that is the whole settle for any `quietMs` it covers (the default 250 ms among them), instead of
	 * two or more dumps compared by hash (3.8 s). A longer `quietMs` still compares successive snapshots (the base's
	 * hash settle; `timeoutMs` bounds only that comparison). A failed dump, or one that took so long it gave up
	 * waiting for idle, is not quiet. With the server on, none of this runs unless the server could not do the
	 * settle: it waits for the accessibility events to stop by itself, for any `quietMs`. (The single dump is the
	 * dump's idle wait, which a server snapshot does not have, so it is always a real dump here.)
	 */
	protected override async nativeSettle(o: { quietMs: number; timeoutMs: number }) {
		const fast = await this.uiad?.settle(o);
		if (fast !== undefined) return fast;
		if (o.quietMs > DUMP_IDLE_MS) return undefined;
		const start = this.time.now();
		const taken = await this.dumpSnapshot();
		const waitedMs = this.time.now() - start;
		spanDetails.note("via", "snapshot");
		return {
			success: true as const,
			data: { quiet: taken.success && waitedMs < DUMP_IDLE_TIMEOUT_MS, waitedMs, via: "snapshot" as const },
		};
	}

	readonly alert: Driver["alert"] = async (): DriverResult<AlertInfo | null> => {
		const taken = await this.takeSnapshot();
		return taken.success ? { success: true, data: androidAlert.detectAlert(taken.data.flat) } : taken;
	};

	readonly alertIn: DetectsAlerts["alertIn"] = (snapshot) => androidAlert.detectAlert(snapshot.flat);

	readonly appearance: Driver["appearance"] = async (set) => {
		if (set) {
			const saved = await this.facts.settings?.beforeAppearance();
			if (saved && !saved.success) return saved;
			const res = await androidDevice.runChecked(
				this.session,
				androidArgv.shellCommand(androidArgv.uimodeSetArgv(set === "dark")),
				"E_UNSUPPORTED"
			);
			return res.success ? { success: true, data: set } : res;
		}
		const res = await androidDevice.runChecked(
			this.session,
			androidArgv.shellCommand(androidArgv.uimodeGetArgv()),
			"E_UNSUPPORTED"
		);
		if (!res.success) return res;
		return { success: true, data: /Night mode:\s*yes/i.test(res.data) ? "dark" : "light" };
	};

	readonly clipboard: Driver["clipboard"] = async () =>
		driverErrors.err("E_UNSUPPORTED", "Android has no public shell clipboard access; type ASCII with typeText");

	protected override applyNetwork(op: Parameters<Driver["network"]>[0], opts?: Parameters<Driver["network"]>[1]) {
		return this.net.network(op, opts);
	}

	protected override async applyClock(op: Parameters<Driver["clock"]>[0]) {
		const { session, options, adb, serial } = this;
		return new AndroidClock({ session, exec: options.exec, adb, serial }).apply(op);
	}

	/** `adb emu geo fix` works on emulators only; the console takes longitude first. The last fix stays after `clear`. */
	protected override locationGuard(): DriverError | undefined {
		if (this.serial.startsWith("emulator-")) return undefined;
		return driverErrors.make("E_UNSUPPORTED", `location needs an emulator; ${this.serial} has no emulator console`);
	}

	protected override setLocationFix(point: LatLon, altM?: number): DriverResult<void> {
		return this.geoFix(point, altM);
	}

	/**
	 * `emu finger touch <id>` on the emulator console presents a fingerprint (id 1 is the enrolled one, 99 matches
	 * nothing); `dumpsys fingerprint` says whether any is enrolled. Enrollment itself is baked into the golden snapshot.
	 */
	readonly biometrics: Driver["biometrics"] = async (op) => {
		if (!androidArgv.isEmulatorSerial(this.serial)) {
			return driverErrors.err("E_UNSUPPORTED", `biometrics need an emulator, not the physical device ${this.serial}`);
		}
		if (op === "enroll" || op === "unenroll") {
			return driverErrors.err(
				"E_UNSUPPORTED",
				`Android fingerprint enrollment comes from the golden snapshot (profile \`biometrics: true\`); \`${op}\` is not available at run time`
			);
		}
		if (op !== "status") {
			const touched = await this.touchSensor(op === "match" ? 1 : UNENROLLED_FINGER_ID);
			if (!touched.success) return touched;
		}
		const dump = await androidDevice.runChecked(
			this.session,
			androidArgv.shellCommand(androidArgv.dumpsysFingerprintArgv()),
			"E_UNSUPPORTED"
		);
		if (!dump.success) return dump;
		const state: BiometricState = { enrolled: androidBiometrics.isEnrolled(dump.data), modality: "fingerprint" };
		return { success: true, data: state };
	};

	protected override async stopHelper(): Promise<void> {
		await this.uiad?.stop();
	}

	protected override async restoreSettings(): Promise<void> {
		await this.facts.animations.restore();
		await this.facts.settings?.restore();
	}

	protected override async teardown(): Promise<void> {
		await this.session.close();
	}

	/**
	 * See `SelectsAll`: the server selects the focused field's text whole; without it, Ctrl+A on the Androids that
	 * have `input keycombination`. A refusal here is not an error for the caller, which presses Backspace per character.
	 */
	private readonly runSelectAll: SelectsAll["selectAll"] = async () => {
		const fast = await this.uiad?.selectAll();
		if (fast !== undefined) return fast;
		if (this.sdk === undefined || this.sdk < SELECT_ALL_MIN_SDK) {
			return driverErrors.err(
				"E_UNSUPPORTED",
				"select-all needs the warden-uiad server or Android 13+ (`input keycombination`)"
			);
		}
		return this.input(androidArgv.shellCommand(androidArgv.selectAllArgv()));
	};

	/**
	 * See `SetsText`: the server replaces the focused field's text (`ACTION_SET_TEXT`, the action its `typeText` inserts
	 * with). There is no shell fallback: a refusal or a server that is off is `E_UNSUPPORTED`, and the caller types.
	 */
	private readonly runSetText: SetsText["setText"] = async (text) =>
		(await this.uiad?.setText(text)) ?? driverErrors.err("E_UNSUPPORTED", "setText needs the warden-uiad server");

	private async dumpWithRetry(): ReturnType<Dumper["dump"]> {
		let dumped = await this.dumper.dump();
		for (
			let attempt = 1;
			attempt < SNAPSHOT_ATTEMPTS && !dumped.success && dumped.error.code === "E_AX_UNAVAILABLE";
			attempt++
		) {
			this.options.log?.(`uiautomator unavailable, retrying (${attempt}/${SNAPSHOT_ATTEMPTS - 1})`);
			await this.time.sleep(SNAPSHOT_RETRY_MS);
			dumped = await this.dumper.dump();
		}
		return dumped;
	}

	private async dumpSnapshot(): DriverResult<Snapshot> {
		spanDetails.note("backend", "dump");
		const dumped = await this.dumpWithRetry();
		if (!dumped.success) return dumped;
		let parsed: ReturnType<typeof uiautomatorParser.parseUiautomatorXml>;
		const rotation = androidDevice.hierarchyRotation(dumped.data.xml);
		const screen = androidDevice.rotatedScreen(this.baseScreen, rotation);
		try {
			parsed = uiautomatorParser.parseUiautomatorXml(dumped.data.xml, screen);
		} catch (error) {
			if (error instanceof UiautomatorParseError) return driverErrors.err("E_AX_UNAVAILABLE", error.message);
			throw error;
		}
		const taken: Snapshot = {
			platform: "android",
			backend: "uiautomator",
			takenAt: this.time.now(),
			screen,
			...parsed,
			truncated: false,
		};
		return { success: true, data: taken };
	}

	/** The server's snapshot when it is running (tens of ms); else, or when it cannot be used, `uiautomator dump` (about 2 s). */
	protected async takeSnapshot(): DriverResult<Snapshot> {
		return (await this.uiad?.snapshot()) ?? this.dumpSnapshot();
	}

	protected override async pollHash(): Promise<string> {
		const taken = await this.takeSnapshot();
		if (!taken.success) return "unavailable";
		// snapshotHash ignores `text`; on Android static text lives there, so fold it into `value`
		return settler.snapshotHash({ flat: taken.data.flat.map((e) => ({ ...e, value: e.value ?? e.text })) });
	}

	private async input(cmd: string, timeoutMs?: number): DriverResult<void> {
		const res = await androidDevice.runChecked(this.session, cmd, "E_HID", timeoutMs);
		return res.success ? unit : res;
	}

	/**
	 * Replays a plan. With the server: one multi-pointer MotionEvent stream. Without it (or when it refuses): one
	 * finger as a downsampled `input motionevent` line on sdk 26+; two fingers cannot be injected by `input`.
	 */
	private async runGesture(plan: GesturePlan): DriverResult<void> {
		const fast = await this.uiad?.gesture(plan);
		if (fast !== undefined) return fast;
		if (plan.paths.length > 1) {
			return driverErrors.err(
				"E_UNSUPPORTED",
				"two-finger gestures need the warden-uiad server (API 26+, WARDEN_ANDROID_UIAD not 0)"
			);
		}
		if (this.sdk === undefined || this.sdk < MOTIONEVENT_MIN_SDK) {
			return driverErrors.err(
				"E_UNSUPPORTED",
				"gestures need Android 8+ (`input motionevent`) or the warden-uiad server"
			);
		}
		return this.input(
			androidArgv.gestureMotionCommand(plan),
			INPUT_TEXT_BASE_MS + plan.totalMs + (GESTURE_LINE_MAX_MOVES + 2) * DRAG_PROCESS_BUDGET_MS
		);
	}

	/** pointers `gesture` takes: 2 with the server, 1 where `input motionevent` exists (sdk is known at open), else 0 */
	private maxPointers(): 0 | 1 | 2 {
		if (this.uiad?.enabled()) return 2;
		return this.sdk !== undefined && this.sdk >= MOTIONEVENT_MIN_SDK ? 1 : 0;
	}

	private async geoFix(point: LatLon, altM?: number): DriverResult<void> {
		const res = await this.options.exec(androidArgv.geoFixArgv(this.adb, this.serial, point, altM), {
			timeoutMs: GEO_FIX_MS,
		});
		const failure = androidArgv.geoFixFailure(res);
		return failure === undefined ? unit : driverErrors.err("E_IO", failure);
	}

	private async touchSensor(fingerId: number): DriverResult<void> {
		const touched = await this.options.exec(androidArgv.emuFingerTouchArgv(this.adb, this.serial, fingerId), {
			timeoutMs: 10_000,
		});
		// the console answers `KO: …` (and some builds still exit 0) when the sensor is missing
		if (touched.exitCode === 0 && !/^KO\b/m.test(touched.stdout)) return { success: true, data: undefined };
		return driverErrors.err(
			"E_IO",
			`adb emu finger touch failed: ${`${touched.stdout}${touched.stderr}`.trim().slice(0, 200)}`
		);
	}
}

/** Opens {@link AndroidDriver}s. Use the shared {@link androidDrivers} singleton. */
export class AndroidDrivers {
	/** Deepest hittable element containing `point` (later in preorder wins ties: drawn on top); else deepest any. */
	elementAt(flat: readonly Element[], point: Point): Element | null {
		return elementHitTest.at(flat, point);
	}

	/**
	 * Opens the shell session, waits for the device, turns animations off and returns the {@link AndroidDriver}. A
	 * failure after the shell opened closes it again.
	 */
	async open(options: AndroidDriverOptions): DriverResult<Driver> {
		const { serial, adb, log } = options;
		const clock = options.clock ?? realClock;
		const execBinary = options.execBinary ?? bunExecBinary;
		const session = adbSessions.open({
			adb,
			serial,
			...(options.spawn ? { spawn: options.spawn } : {}),
			...(log ? { log } : {}),
		});

		const failed = async (error: DriverError): DriverResult<never> => {
			await session.close();
			return { success: false, error };
		};

		const prepared = await this.prepare(options, session, clock);
		if (!prepared.success) return failed(prepared.error);
		const { sdk, phone, screen, savedState } = prepared.data;
		const saved = androidState.forSdk(savedState, sdk);
		const animations = await new AndroidAnimations({
			session,
			serial,
			sdk,
			pending: saved.animations,
			...(options.state ? { state: options.state } : {}),
			...(log ? { log } : {}),
		}).disable();
		const settings = phone
			? await androidPhone.createSettingsGuard({
					session,
					serial,
					sdk,
					pending: { rotation: saved.rotation, uimode: saved.uimode },
					...(options.state ? { state: options.state } : {}),
					...(log ? { log } : {}),
				})
			: undefined;
		return {
			success: true,
			data: new AndroidDriver(options, session, screen, clock, execBinary, {
				sdk,
				savedRoute: saved.dumpRoute,
				savedUiadUnsupported: saved.uiadUnsupported,
				animations,
				settings,
				physical: phone !== undefined,
			}),
		};
	}

	/** Waits for boot, wakes a physical phone, reads the screen and the saved state; what the driver needs before it is built. */
	private async prepare(
		options: AndroidDriverOptions,
		session: AdbSession,
		clock: Clock
	): DriverResult<{
		sdk: number | undefined;
		phone: BootInfo["physical"];
		screen: ScreenInfo;
		savedState: AndroidDeviceState;
	}> {
		const { serial, log } = options;
		const savedState = options.state?.read(serial);
		const booted = await androidDevice.waitForBoot(session, serial, clock, {
			...(options.bootTimeoutMs !== undefined ? { timeoutMs: options.bootTimeoutMs } : {}),
			...(log ? { log } : {}),
		});
		if (!booted.success) return booted;
		const phone = booted.data.physical;
		if (phone) {
			const awake = await androidPhone.preparePhone(session, clock, phone, log);
			if (!awake.success) return awake;
		}
		const probed = options.screen ?? booted.data.screen;
		const screen = probed ? { success: true as const, data: probed } : await androidDevice.readScreen(session, serial);
		if (!screen.success) return screen;
		return {
			success: true,
			data: { sdk: booted.data.sdk, phone, screen: screen.data, savedState: (await savedState) ?? {} },
		};
	}
}

export const androidDrivers = new AndroidDrivers();
