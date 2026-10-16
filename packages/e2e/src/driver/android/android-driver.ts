import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Exec } from "@delacour/warden-core/exec";
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
	Logger,
	Modifier,
	Orientation,
	Point,
	ScreenInfo,
	Snapshot,
} from "../driver.types";
import { driverErr } from "../errors";
import { DEFAULT_SETTLE_QUIET_MS, DEFAULT_SETTLE_TIMEOUT_MS, settleByHash, snapshotHash } from "../settle";
import type { RepeatingKeys } from "../typing";
import { type AdbSession, openAdbSession, type SpawnAdb } from "./adb-session";
import { detectAlert } from "./android-alert";
import { type AnimationGuard, disableAnimations } from "./android-animations";
import { createAppCommands } from "./android-app";
import {
	buttonKeycode,
	DRAG_STEPS,
	dragMotionCommand,
	getpropArgv,
	keycombinationArgv,
	keyeventArgv,
	keyNameKeycode,
	keyRepeatArgvs,
	longPressArgv,
	MOTIONEVENT_MIN_SDK,
	modifierKeycode,
	rotationArgvs,
	screencapArgv,
	shellCommand,
	swipeArgv,
	tapArgv,
	textArgvs,
	uimodeGetArgv,
	uimodeSetArgv,
	userRotationArgv,
} from "./android-argv";
import {
	type Clock,
	hierarchyRotation,
	orientationToRotation,
	readScreen,
	realClock,
	rotatedScreen,
	rotationToOrientation,
	runChecked,
	waitForBoot,
} from "./android-device";
import { createDumper, type DumpRoute } from "./android-dump";
import { type AndroidStateStore, forSdk, patchFor } from "./android-state";
import { interactiveFilter, parseUiautomatorXml, UiautomatorParseError } from "./uiautomator";

/** Binary-safe host process runner (screenshots); `Exec` is text-only. */
export type ExecBinary = (
	argv: readonly string[],
	opts?: { timeoutMs?: number }
) => Promise<{ exitCode: number; stdout: Uint8Array }>;

/** Default {@link ExecBinary}: `Bun.spawn`, stderr dropped, never throws (a spawn failure is exit 127). */
export const bunExecBinary: ExecBinary = async (argv, opts = {}) => {
	try {
		const proc = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: opts.timeoutMs });
		const [bytes, exitCode] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
		return { exitCode, stdout: new Uint8Array(bytes) };
	} catch {
		return { exitCode: 127, stdout: new Uint8Array() };
	}
};

export type AndroidDriverOptions = {
	serial: string;
	/** path of the `adb` binary (`androidTools(env).adb`) */
	adb: string;
	/** text-only host runner (`bunExec` in production): `adb install`, the `exec-out` dump route */
	exec: Exec;
	/** override how the resident shell is spawned (tests) */
	spawn?: SpawnAdb;
	log?: Logger;
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
	/** how long to wait for `sys.boot_completed`, default 30 s */
	bootTimeoutMs?: number;
};

const CAPABILITIES: DriverCapabilities = {
	pinch: false,
	unicodeText: false,
	nativeSettle: false,
	alerts: true,
	reachability: true,
};

const SNAPSHOT_CACHE_MS = 1_000;
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
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

const unit = { success: true as const, data: undefined };

/** Deepest hittable element containing `point` (later in preorder wins ties: drawn on top); else deepest any. */
export function elementAt(flat: readonly Element[], point: Point): Element | null {
	const inside = flat.filter(
		(e) =>
			point.x >= e.frame.x &&
			point.x < e.frame.x + e.frame.width &&
			point.y >= e.frame.y &&
			point.y < e.frame.y + e.frame.height
	);
	const deepest = (list: readonly Element[]): Element | undefined =>
		list.reduce<Element | undefined>((best, e) => (best === undefined || e.depth >= best.depth ? e : best), undefined);
	return deepest(inside.filter((e) => e.hittable)) ?? deepest(inside) ?? null;
}

/** Wrap every `AppCommands` method so the cached snapshot is dropped when the app changes what is on screen. */
function invalidating(app: AppCommands, drop: () => void): AppCommands {
	const wrap =
		<A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
		async (...args: A): Promise<R> => {
			drop();
			const result = await fn(...args);
			drop();
			return result;
		};
	return {
		launch: wrap(app.launch),
		terminate: wrap(app.terminate),
		openUrl: wrap(app.openUrl),
		install: app.install,
		uninstall: app.uninstall,
		isInstalled: app.isInstalled,
		isRunning: app.isRunning,
		clearData: wrap(app.clearData),
	};
}

/**
 * Android `Driver`: one resident `adb shell` (inputs, `am`, `pm`, dumps), host `adb` for install and
 * `exec-out` (binary screenshots never touch the session). `settle` is implemented here over snapshots (one dump,
 * or `settleByHash` for a long quiet window), so the TS layer needs no fallback (`nativeSettle: false`). The
 * animation scales it turns off on open are put back by `close`.
 */
export async function openAndroidDriver(options: AndroidDriverOptions): DriverResult<Driver> {
	const { serial, adb, log } = options;
	const clock = options.clock ?? realClock;
	const execBinary = options.execBinary ?? bunExecBinary;
	const session = openAdbSession({
		adb,
		serial,
		...(options.spawn ? { spawn: options.spawn } : {}),
		...(log ? { log } : {}),
	});

	const failed = async (error: DriverError): DriverResult<never> => {
		await session.close();
		return { success: false, error };
	};

	const savedState = options.state?.read(serial);
	const booted = await waitForBoot(session, serial, clock, {
		...(options.bootTimeoutMs !== undefined ? { timeoutMs: options.bootTimeoutMs } : {}),
		...(log ? { log } : {}),
	});
	if (!booted.success) return failed(booted.error);
	const sdk = booted.data.sdk;
	const probed = options.screen ?? booted.data.screen;
	const screen = probed ? { success: true as const, data: probed } : await readScreen(session, serial);
	if (!screen.success) return failed(screen.error);
	const saved = forSdk((await savedState) ?? {}, sdk);
	const animations = await disableAnimations({
		session,
		serial,
		sdk,
		pending: saved.animations,
		...(options.state ? { state: options.state } : {}),
		...(log ? { log } : {}),
	});
	return {
		success: true,
		data: buildDriver(options, session, screen.data, clock, execBinary, {
			sdk,
			savedRoute: saved.dumpRoute,
			animations,
		}),
	};
}

/** What `openAndroidDriver` learned about the device that the driver needs: its API level, saved route, animation guard. */
type DeviceFacts = { sdk: number | undefined; savedRoute: DumpRoute | undefined; animations: AnimationGuard };

function buildDriver(
	options: AndroidDriverOptions,
	session: AdbSession,
	baseScreen: ScreenInfo,
	clock: Clock,
	execBinary: ExecBinary,
	facts: DeviceFacts
): Driver & RepeatingKeys {
	const { serial, adb, exec, log } = options;
	const { sdk } = facts;
	const initialRoute = options.dumpRoute ?? facts.savedRoute;
	const saving: Promise<void>[] = [];
	const dumper = createDumper({
		session,
		exec,
		adb,
		serial,
		...(sdk !== undefined ? { sdk } : {}),
		...(log ? { log } : {}),
		...(initialRoute ? { initialRoute } : {}),
		onRoute: (route) => {
			options.onDumpRoute?.(route);
			if (options.state) saving.push(options.state.update(serial, patchFor(sdk, { dumpRoute: route })));
		},
	});
	let last: Snapshot | undefined;

	async function dumpWithRetry(): ReturnType<typeof dumper.dump> {
		let dumped = await dumper.dump();
		for (
			let attempt = 1;
			attempt < SNAPSHOT_ATTEMPTS && !dumped.success && dumped.error.code === "E_AX_UNAVAILABLE";
			attempt++
		) {
			log?.(`uiautomator unavailable, retrying (${attempt}/${SNAPSHOT_ATTEMPTS - 1})`);
			await clock.sleep(SNAPSHOT_RETRY_MS);
			dumped = await dumper.dump();
		}
		return dumped;
	}

	async function takeSnapshot(): DriverResult<Snapshot> {
		const dumped = await dumpWithRetry();
		if (!dumped.success) return dumped;
		let parsed: ReturnType<typeof parseUiautomatorXml>;
		const rotation = hierarchyRotation(dumped.data.xml);
		const screen = rotatedScreen(baseScreen, rotation);
		try {
			parsed = parseUiautomatorXml(dumped.data.xml, screen);
		} catch (error) {
			if (error instanceof UiautomatorParseError) return driverErr("E_AX_UNAVAILABLE", error.message);
			throw error;
		}
		last = { platform: "android", backend: "uiautomator", takenAt: clock.now(), screen, ...parsed, truncated: false };
		return { success: true, data: last };
	}

	const input = async (cmd: string, timeoutMs?: number): DriverResult<void> => {
		last = undefined;
		const res = await runChecked(session, cmd, "E_HID", timeoutMs);
		last = undefined;
		return res.success ? unit : res;
	};

	const snapshot: Driver["snapshot"] = async (opts) => {
		if (opts?.backend !== undefined && opts.backend !== "uiautomator") {
			return driverErr("E_UNSUPPORTED", `Android only has the uiautomator backend, not ${opts.backend}`);
		}
		const taken = await takeSnapshot();
		if (!taken.success || !opts?.interactiveOnly) return taken;
		return { success: true, data: { ...taken.data, ...interactiveFilter(taken.data.elements) } };
	};

	const elementAtPoint: Driver["elementAtPoint"] = async (point) => {
		const fresh = last && clock.now() - last.takenAt < SNAPSHOT_CACHE_MS ? last : undefined;
		const snap = fresh ? { success: true as const, data: fresh } : await takeSnapshot();
		return snap.success ? { success: true, data: elementAt(snap.data.flat, point) } : snap;
	};

	const tap: Driver["tap"] = async (point, opts) => {
		const t0 = clock.now();
		const once = opts?.durationMs ? longPressArgv(point, opts.durationMs) : tapArgv(point);
		const count = Math.max(1, opts?.count ?? 1);
		const res = await input(Array.from({ length: count }, () => shellCommand(once)).join("; "));
		log?.(`tap ${Math.round(point.x)},${Math.round(point.y)} x${count} in ${clock.now() - t0}ms`);
		return res;
	};

	const typeText: Driver["typeText"] = async (text) => {
		const argvs = textArgvs(text);
		if (!argvs.success) return argvs;
		if (argvs.data.length === 0) return unit;
		// every `input text` is its own JVM start (hundreds of ms, seconds under load): budget per piece
		return input(
			argvs.data.map((argv) => shellCommand(argv)).join(" && "),
			INPUT_TEXT_BASE_MS + INPUT_TEXT_PIECE_MS * argvs.data.length
		);
	};

	const key: Driver["key"] = async (name: KeyName, modifiers: readonly Modifier[] = []) => {
		const code = keyNameKeycode(name);
		if (modifiers.length === 0) return input(shellCommand(keyeventArgv(code)));
		const res = await session.run(shellCommand(keycombinationArgv([...modifiers.map(modifierKeycode), code])));
		if (!res.success) return res;
		return res.data.exitCode === 0
			? unit
			: driverErr("E_UNSUPPORTED", "key modifiers need Android 13+ (`input keycombination`)");
	};

	/** See `RepeatingKeys`: N presses in one round trip (`input keyevent 67 67 67 …`). */
	const pressKeyRepeat: RepeatingKeys["pressKeyRepeat"] = async (name, times) => {
		const argvs = keyRepeatArgvs(keyNameKeycode(name), times);
		if (argvs.length === 0) return unit;
		return input(
			argvs.map((argv) => shellCommand(argv)).join(" && "),
			INPUT_TEXT_BASE_MS + INPUT_TEXT_PIECE_MS * argvs.length
		);
	};

	/**
	 * Hold-then-move on sdk 26+ (`input motionevent` DOWN, interpolated MOVEs, UP, one shell line); older images
	 * and an unreadable sdk fall back to a long `input swipe` (no hold).
	 */
	const drag: Driver["drag"] = async (from, to, opts) => {
		const timing = {
			pressMs: opts?.pressMs ?? DRAG_PRESS_MS,
			durationMs: opts?.durationMs ?? DRAG_MOVE_MS,
			releaseMs: opts?.releaseMs ?? 0,
		};
		if (sdk === undefined || sdk < MOTIONEVENT_MIN_SDK) {
			return input(shellCommand(swipeArgv(from, to, timing.pressMs + timing.durationMs + timing.releaseMs)));
		}
		const total = timing.pressMs + timing.durationMs + timing.releaseMs;
		return input(
			dragMotionCommand(from, to, timing),
			INPUT_TEXT_BASE_MS + total + (DRAG_STEPS + 2) * DRAG_PROCESS_BUDGET_MS
		);
	};

	const pressButton: Driver["pressButton"] = async (button: HardwareButton) => {
		const code = buttonKeycode(button);
		return code === undefined
			? driverErr("E_UNSUPPORTED", `Android has no ${button} button`)
			: input(shellCommand(keyeventArgv(code)));
	};

	const screenshot: Driver["screenshot"] = async (opts) => {
		const res = await execBinary(screencapArgv(adb, serial), { timeoutMs: SCREENSHOT_TIMEOUT_MS });
		if (res.exitCode !== 0 || !PNG_MAGIC.every((b, i) => res.stdout[i] === b)) {
			return driverErr("E_IO", `screencap on ${serial} gave no PNG (exit ${res.exitCode}, ${res.stdout.length} bytes)`);
		}
		if (!opts?.path) return { success: true, data: { png: res.stdout } };
		try {
			await mkdir(dirname(opts.path), { recursive: true });
			await writeFile(opts.path, res.stdout);
		} catch (error) {
			return driverErr("E_IO", `cannot write ${opts.path}: ${error instanceof Error ? error.message : String(error)}`);
		}
		return { success: true, data: { path: opts.path } };
	};

	const orientation: Driver["orientation"] = async (set?: Orientation) => {
		if (set) {
			for (const argv of rotationArgvs(orientationToRotation(set))) {
				const res = await input(shellCommand(argv));
				if (!res.success) return res;
			}
			return { success: true, data: set };
		}
		const res = await session.run(shellCommand(userRotationArgv()));
		if (!res.success) return res;
		const n = Number.parseInt(res.data.stdout.trim(), 10);
		return { success: true, data: rotationToOrientation(Number.isNaN(n) ? 0 : n) };
	};

	/**
	 * `uiautomator dump` waits for a second without accessibility events before it reads, so one dump is already
	 * "quiet for 1 s": that is the whole settle for any `quietMs` it covers (the default 250 ms among them), instead of
	 * two or more dumps compared by hash (3.8 s). A longer `quietMs` still compares successive dumps. A failed dump,
	 * or one that took so long it gave up waiting for idle, is not quiet. `timeoutMs` bounds only that comparison.
	 */
	const settle: Driver["settle"] = async (opts) => {
		const quietMs = opts?.quietMs ?? DEFAULT_SETTLE_QUIET_MS;
		if (quietMs <= DUMP_IDLE_MS) {
			const start = clock.now();
			const taken = await takeSnapshot();
			const waitedMs = clock.now() - start;
			return { success: true, data: { quiet: taken.success && waitedMs < DUMP_IDLE_TIMEOUT_MS, waitedMs } };
		}
		const poll = async (): Promise<string> => {
			const taken = await takeSnapshot();
			if (!taken.success) return "unavailable";
			// snapshotHash ignores `text`; on Android static text lives there, so fold it into `value`
			return snapshotHash({ flat: taken.data.flat.map((e) => ({ ...e, value: e.value ?? e.text })) });
		};
		const outcome = await settleByHash(poll, {
			quietMs,
			timeoutMs: opts?.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS,
			now: clock.now,
			sleep: clock.sleep,
		});
		return { success: true, data: outcome };
	};

	const alert: Driver["alert"] = async (): DriverResult<AlertInfo | null> => {
		const taken = await takeSnapshot();
		return taken.success ? { success: true, data: detectAlert(taken.data.flat) } : taken;
	};

	const appearance: Driver["appearance"] = async (set) => {
		if (set) {
			const res = await runChecked(session, shellCommand(uimodeSetArgv(set === "dark")), "E_UNSUPPORTED");
			return res.success ? { success: true, data: set } : res;
		}
		const res = await runChecked(session, shellCommand(uimodeGetArgv()), "E_UNSUPPORTED");
		if (!res.success) return res;
		return { success: true, data: /Night mode:\s*yes/i.test(res.data) ? "dark" : "light" };
	};

	const clipboard: Driver["clipboard"] = async () =>
		driverErr("E_UNSUPPORTED", "Android has no public shell clipboard access; type ASCII with typeText");

	const health: Driver["health"] = async () => {
		const [release, sdk, model] = await Promise.all(
			["ro.build.version.release", "ro.build.version.sdk", "ro.product.model"].map((k) =>
				session.run(shellCommand(getpropArgv(k)))
			)
		);
		const text = (r: typeof release): string => (r?.success ? r.data.stdout.trim() : "");
		const info: HealthInfo = {
			platform: "android",
			id: serial,
			version: `Android ${text(release)} (sdk ${text(sdk)})`,
			transport: "adb",
			screen: baseScreen,
			detail: { model: text(model), dumpRoute: dumper.route() ?? null },
		};
		return { success: true, data: info };
	};

	const unsupported = (what: string) => async () => driverErr("E_UNSUPPORTED", `${what} is not supported on Android`);

	return {
		platform: "android",
		id: serial,
		capabilities: CAPABILITIES,
		health,
		snapshot,
		elementAtPoint,
		tap,
		longPress: (point, opts) => input(shellCommand(longPressArgv(point, opts?.durationMs))),
		swipe: (from, to, opts) => input(shellCommand(swipeArgv(from, to, opts?.durationMs))),
		drag,
		pinch: unsupported("pinch"),
		typeText,
		key,
		pressKeyRepeat,
		pressButton,
		screenshot,
		orientation,
		settle,
		alert,
		appearance,
		clipboard,
		app: invalidating(
			createAppCommands({
				session,
				exec,
				adb,
				serial,
				...(log ? { log } : {}),
				...(options.appPackage ? { appPackage: options.appPackage } : {}),
			}),
			() => {
				last = undefined;
			}
		),
		close: async () => {
			await facts.animations.restore();
			await Promise.all(saving.splice(0));
			await session.close();
		},
	};
}
