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
import { createAppCommands } from "./android-app";
import {
	animationScaleArgvs,
	buttonKeycode,
	getpropArgv,
	keycombinationArgv,
	keyeventArgv,
	keyNameKeycode,
	keyRepeatArgvs,
	longPressArgv,
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
	/** told when a dump route is first found to work or changes, to persist it */
	onDumpRoute?: (route: DumpRoute) => void;
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
/** uiautomator fails transiently (`null root node`) while a window is opening; a few quick retries ride it out. */
const SNAPSHOT_ATTEMPTS = 3;
const INPUT_TEXT_BASE_MS = 10_000;
const INPUT_TEXT_PIECE_MS = 8_000;
const SNAPSHOT_RETRY_MS = 400;
const SCREENSHOT_TIMEOUT_MS = 10_000;
const DRAG_PRESS_MS = 500;
const DRAG_MOVE_MS = 600;
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
 * `exec-out` (binary screenshots never touch the session). `settle` is implemented here with `settleByHash`
 * over snapshots, so the TS layer needs no fallback (`nativeSettle: false`).
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

	const booted = await waitForBoot(session, serial, clock, {
		...(options.bootTimeoutMs !== undefined ? { timeoutMs: options.bootTimeoutMs } : {}),
		...(log ? { log } : {}),
	});
	if (!booted.success) return failed(booted.error);
	const probed = options.screen ?? booted.data;
	const screen = probed ? { success: true as const, data: probed } : await readScreen(session, serial);
	if (!screen.success) return failed(screen.error);
	const animations = await session.run(
		animationScaleArgvs()
			.map((argv) => shellCommand(argv))
			.join("; ")
	);
	if (!animations.success || animations.data.exitCode !== 0) log?.("could not disable animations");
	return { success: true, data: buildDriver(options, session, screen.data, clock, execBinary) };
}

function buildDriver(
	options: AndroidDriverOptions,
	session: AdbSession,
	baseScreen: ScreenInfo,
	clock: Clock,
	execBinary: ExecBinary
): Driver & RepeatingKeys {
	const { serial, adb, exec, log } = options;
	const dumper = createDumper({
		session,
		exec,
		adb,
		serial,
		...(log ? { log } : {}),
		...(options.dumpRoute ? { initialRoute: options.dumpRoute } : {}),
		...(options.onDumpRoute ? { onRoute: options.onDumpRoute } : {}),
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

	const settle: Driver["settle"] = async (opts) => {
		const poll = async (): Promise<string> => {
			const taken = await takeSnapshot();
			if (!taken.success) return "unavailable";
			// snapshotHash ignores `text`; on Android static text lives there, so fold it into `value`
			return snapshotHash({ flat: taken.data.flat.map((e) => ({ ...e, value: e.value ?? e.text })) });
		};
		const outcome = await settleByHash(poll, {
			quietMs: opts?.quietMs ?? DEFAULT_SETTLE_QUIET_MS,
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
		drag: (from, to, opts) =>
			input(
				shellCommand(
					swipeArgv(
						from,
						to,
						(opts?.pressMs ?? DRAG_PRESS_MS) + (opts?.durationMs ?? DRAG_MOVE_MS) + (opts?.releaseMs ?? 0)
					)
				)
			),
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
		app: invalidating(createAppCommands({ session, exec, adb, serial, ...(log ? { log } : {}) }), () => {
			last = undefined;
		}),
		close: () => session.close(),
	};
}
