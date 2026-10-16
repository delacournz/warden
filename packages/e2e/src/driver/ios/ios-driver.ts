import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Exec } from "@delacour/warden-core/exec";
import { wardenHome as resolveWardenHome } from "@delacour/warden-core/store";
import type { Result } from "@delacour/warden-types/result";
import type { E2eEnv } from "../../env";
import { ENV_NAMES } from "../../env";
import type { AlertBackend, ProbesFrontmost, ReadsAlertOn } from "../alerts";
import type {
	AlertInfo,
	Driver,
	DriverCapabilities,
	DriverError,
	DriverResult,
	HardwareButton,
	HealthInfo,
	KeyName,
	Logger,
	Orientation,
	Snapshot,
} from "../driver.types";
import { driverError } from "../errors";
import { type SettleDetail, settleByHash, snapshotHash } from "../settle";
import { noteSpanDetail } from "../span-detail";
import type { SelectsAll } from "../typing";
import { type SwappableClient, swappableClient } from "./ios-session";
import { locateHelper } from "./locate-helper";
import { normalizeElement, normalizeElements, toSnapshot } from "./normalize";
import { createSimctl, type Simctl } from "./simctl";
import { connectSimd, type SimdClient, spawnSimd } from "./simd-client";
import type { AlertButtonsData, SettleData } from "./simd-protocol";
import type { SimdSpawn } from "./simd-transport";
import { typeTextBudgetMs } from "./type-budget";

/**
 * The iOS `Driver`: input and AX through `warden-simd` (socket when `WARDEN_SIMD_SOCKET` is set, else a
 * helper spawned on stdio), app lifecycle / clipboard / appearance through `xcrun simctl`. Fallbacks:
 * `typeText` pastes what the HID keyboard map cannot type, `settle` polls snapshot hashes when the
 * helper has no native quiescence, `screenshot` uses `simctl io` when the helper cannot.
 */

export type IosDriverEnv = Pick<E2eEnv, "simd" | "simdSocket" | "helperDir">;

/** The iOS driver is a `Driver` plus the optional capabilities of `driver/alerts.ts`. */
export type IosDriver = Driver & SelectsAll & ReadsAlertOn & ProbesFrontmost;

export type OpenIosDriverOptions = {
	udid: string;
	env?: IosDriverEnv;
	exec: Exec;
	spawn?: SimdSpawn;
	log?: Logger;
	/** explicit helper binary (skips {@link locateHelper}) */
	helperPath?: string;
	/** explicit helper socket (wins over `env.simdSocket`) */
	socketPath?: string;
	/**
	 * An already connected (handshaken) helper client: used instead of connecting, so a caller that just
	 * connected to learn the helper was up does not connect twice. The driver owns it from here (`close()`
	 * closes it); a restart still reconnects through the socket / spawn path.
	 */
	client?: SimdClient;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** for `locateHelper` / `$WARDEN_HOME/simd/<version>`; defaults read the process */
	version?: string;
	wardenHome?: string;
	execPath?: string;
	importDir?: string;
	exists?: (path: string) => boolean;
	realpath?: (path: string) => string;
	/** per-request default in ms, 10 s */
	defaultTimeoutMs?: number;
	/** log each helper op and simctl call with its duration (`WARDEN_E2E_DEBUG=1`) */
	debug?: boolean;
	/** CoreSimulator devices directory for the host-side `AutomationEnabled` check (default `~/Library/Developer/CoreSimulator/Devices`) */
	devicesRoot?: string;
};

const DEFAULT_QUIET_MS = 250;
const DEFAULT_SETTLE_TIMEOUT_MS = 5_000;
const SETTLE_MARGIN_MS = 2_000;
const GESTURE_MARGIN_MS = 5_000;
/** `frontmost` is one launchd lookup; a helper that has not answered in this long is busy, and the caller carries on without. */
const FRONTMOST_TIMEOUT_MS = 3_000;

/** USB HID keyboard-page usage ids for the keys `Driver.key` offers. */
export const KEY_USAGE: Readonly<Record<KeyName, number>> = {
	Enter: 0x28,
	Escape: 0x29,
	Backspace: 0x2a,
	Tab: 0x2b,
	Space: 0x2c,
	Delete: 0x4c,
	Right: 0x4f,
	Left: 0x50,
	Down: 0x51,
	Up: 0x52,
};

const BUTTONS: Readonly<Record<Exclude<HardwareButton, "back">, string>> = {
	home: "home",
	lock: "lock",
	volumeUp: "volumeUp",
	volumeDown: "volumeDown",
	shake: "shake",
};

/** Helper errors after which `simctl io screenshot` is worth trying (op missing / failing, not a dead helper). */
const SCREENSHOT_FALLBACK: ReadonlySet<string> = new Set(["E_UNSUPPORTED", "E_IO", "E_BAD_REQUEST", "E_INTERNAL"]);

type Params = Record<string, unknown>;

/** Drops `undefined` so optional driver options are absent on the wire rather than `null`. */
function params(values: Record<string, unknown>): Params {
	return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

const okVoid = { success: true as const, data: undefined };

function fail(error: DriverError) {
	return { success: false as const, error };
}

/** The helper's whole settle verdict, for the caller and for the span timing the call; absent fields stay absent. */
function nativeDetail(data: SettleData): SettleDetail {
	const { quiet, waitedMs, via, reason, frontmostPid } = data;
	const detail: SettleDetail = {
		quiet,
		waitedMs,
		...(via === undefined ? {} : { via }),
		...(reason === undefined ? {} : { reason }),
		...(frontmostPid === undefined ? {} : { frontmostPid }),
	};
	if (via !== undefined) noteSpanDetail("via", via);
	if (reason !== undefined) noteSpanDetail("reason", reason);
	if (frontmostPid !== undefined) noteSpanDetail("frontmostPid", frontmostPid);
	return detail;
}

/** Carries a `DriverError` out of a `settleByHash` poll callback. */
class DriverFailure extends Error {
	constructor(readonly error: DriverError) {
		super(error.message);
	}
}

function restOf(error: DriverError, text: string): string | undefined {
	const detail = error.detail;
	if (typeof detail === "object" && detail !== null && "rest" in detail && typeof detail.rest === "string") {
		return detail.rest;
	}
	return text.length === 0 ? "" : undefined;
}

function decodeBase64(png: string): Uint8Array {
	return new Uint8Array(Buffer.from(png, "base64"));
}

export function createIosDriver(
	swap: SwappableClient,
	simctl: Simctl,
	opts: { udid: string; now: () => number; sleep: (ms: number) => Promise<void>; log?: Logger }
): IosDriver {
	const { udid, now, sleep } = opts;
	const { client } = swap;
	let axFailures = 0;
	/**
	 * The bundle `app.launch` started and no settle has confirmed yet. Right after `simctl launch` the previous
	 * frontmost app (SpringBoard) is still the one the helper sees and it is already quiet, so the next native
	 * settle names this bundle and the helper waits until it is frontmost.
	 */
	let launchedBundle: string | undefined;
	const { ready } = client;
	const nativeSettle = ready.ax.default === "axbridge" && ready.ax.bridge === "available";
	const bridgeUp = ready.ax.bridge === "available";
	let settleUnsupported = !nativeSettle;

	const capabilities: DriverCapabilities = {
		pinch: true,
		unicodeText: true,
		nativeSettle,
		alerts: true,
		reachability: true,
	};

	const send = (op: string, p: Params = {}, timeoutMs?: number) =>
		client.request(op, p, timeoutMs === undefined ? {} : { timeoutMs });

	const sendVoid = async (op: string, p: Params = {}, timeoutMs?: number): DriverResult<void> => {
		const result = await send(op, p, timeoutMs);
		return result.success ? okVoid : result;
	};

	const gestureTimeout = (durationMs: number | undefined, base = 0) => (durationMs ?? 0) + base + GESTURE_MARGIN_MS;

	const fetchSnapshot = async (o?: { interactiveOnly?: boolean; backend?: Snapshot["backend"] }) => {
		const result = await client.request(
			"snapshot",
			params({ interactiveOnly: o?.interactiveOnly, backend: o?.backend })
		);
		if (!result.success) return result;
		const { fallback } = result.data;
		if (fallback) opts.log?.(`[ios] snapshot fell back ${fallback.from} -> ${fallback.to}: ${fallback.reason}`);
		return { success: true, data: toSnapshot(result.data, now()) } as const;
	};

	/**
	 * The first `E_AX_UNAVAILABLE` goes to the caller (it is retryable); a second one in a row means the
	 * in-sim AX bridge went stale, so restart the helper once and retry the snapshot.
	 */
	async function snapshot(o?: { interactiveOnly?: boolean; backend?: Snapshot["backend"] }): DriverResult<Snapshot> {
		const generation = swap.generation();
		const first = await fetchSnapshot(o);
		if (first.success) {
			axFailures = 0;
			return first;
		}
		if (first.error.code !== "E_AX_UNAVAILABLE") {
			axFailures = 0;
			return first;
		}
		axFailures += 1;
		if (axFailures < 2) return first;
		opts.log?.("[ios] E_AX_UNAVAILABLE twice in a row: AX bridge looks stale, restarting warden-simd");
		const restarted = await swap.restart(generation);
		if (!restarted.success) return restarted;
		axFailures = 0;
		return fetchSnapshot(o);
	}

	async function typeText(text: string): DriverResult<void> {
		const typed = await sendVoid("typeText", { text }, typeTextBudgetMs(text));
		if (typed.success || typed.error.code !== "E_UNSUPPORTED_TEXT") return typed;
		const rest = restOf(typed.error, text);
		if (rest === undefined) return typed;
		const copied = await simctl.pbcopy(rest);
		if (!copied.success) return copied;
		opts.log?.(`[ios] typeText: pasting ${rest.length} unmappable character(s)`);
		return sendVoid("paste");
	}

	async function hashSettle(o: { quietMs: number; timeoutMs: number }): DriverResult<SettleDetail> {
		try {
			const outcome = await settleByHash(
				async () => {
					const snap = await snapshot();
					if (!snap.success) throw new DriverFailure(snap.error);
					return snapshotHash(snap.data);
				},
				{ quietMs: o.quietMs, timeoutMs: o.timeoutMs, now, sleep }
			);
			noteSpanDetail("via", "hash");
			return { success: true, data: { ...outcome, via: "hash" } };
		} catch (error) {
			if (error instanceof DriverFailure) return fail(error.error);
			throw error;
		}
	}

	async function settle(o: { quietMs?: number; timeoutMs?: number } = {}): DriverResult<SettleDetail> {
		const quietMs = o.quietMs ?? DEFAULT_QUIET_MS;
		const timeoutMs = o.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
		if (!settleUnsupported) {
			// the helper's budget is `settleTimeoutMs`; the envelope `timeoutMs` is only our padded transport timer
			const expected = launchedBundle;
			const native = await client.request(
				"settle",
				{ quietMs, settleTimeoutMs: timeoutMs, ...(expected === undefined ? {} : { bundleId: expected }) },
				{ timeoutMs: timeoutMs + SETTLE_MARGIN_MS }
			);
			if (native.success) {
				// a mismatch means the app never came to the front: keep asking for it on the next settle
				if (expected !== undefined && native.data.reason !== "frontmost_mismatch") launchedBundle = undefined;
				return { success: true, data: nativeDetail(native.data) };
			}
			// settle is best effort: a loaded machine answering after the padded timer means "not quiet", not a failure
			if (native.error.code === "E_TIMEOUT") {
				noteSpanDetail("reason", "helper_timeout");
				return {
					success: true,
					data: { quiet: false, waitedMs: timeoutMs + SETTLE_MARGIN_MS, reason: "helper_timeout" },
				};
			}
			if (native.error.code !== "E_UNSUPPORTED") return native;
			settleUnsupported = true;
			opts.log?.("[ios] native settle unsupported, polling snapshot hashes");
		}
		return hashSettle({ quietMs, timeoutMs });
	}

	async function screenshot(o?: { path?: string; scale?: number }): DriverResult<{ path?: string; png?: Uint8Array }> {
		const viaHelper = await client.request("screenshot", params({ path: o?.path, scale: o?.scale }));
		if (viaHelper.success) {
			const { path, png } = viaHelper.data;
			if (o?.path) return { success: true, data: { path: path ?? o.path } };
			if (png !== undefined) return { success: true, data: { png: decodeBase64(png) } };
			if (path !== undefined) return { success: true, data: { path } };
			return fail(driverError("E_INTERNAL", "warden-simd screenshot returned neither path nor png"));
		}
		if (!SCREENSHOT_FALLBACK.has(viaHelper.error.code)) return viaHelper;
		opts.log?.(`[ios] helper screenshot failed (${viaHelper.error.code}), using simctl io`);
		return simctl.screenshot(o?.path);
	}

	function toAlertInfo(data: NonNullable<AlertButtonsData>): AlertInfo {
		const { title, message, buttons } = data;
		const info: AlertInfo = { buttons: normalizeElements(buttons, client.ready.screen).elements };
		if (title !== undefined) info.title = title;
		if (message !== undefined) info.message = message;
		return info;
	}

	/** The helper's `alertButtons`: both readers without a `backend`, only that one with it. */
	async function readAlert(backend?: AlertBackend): DriverResult<AlertInfo | null> {
		const result = await client.request("alertButtons", params({ backend }));
		if (!result.success) return result;
		return { success: true, data: result.data === null ? null : toAlertInfo(result.data) };
	}

	const alert = (): DriverResult<AlertInfo | null> => readAlert();

	/** Without the bridge `axbridge` has nothing to read: the host reader is the one reader left. */
	const alertOn = (backend: AlertBackend): DriverResult<AlertInfo | null> =>
		readAlert(backend === "axbridge" && !bridgeUp ? "ax" : backend);

	async function isFrontmost(bundleId: string): DriverResult<boolean> {
		if (!bridgeUp) return fail(driverError("E_UNSUPPORTED", "frontmost needs the axbridge backend"));
		const result = await client.request("frontmost", { bundleId }, { timeoutMs: FRONTMOST_TIMEOUT_MS });
		return result.success ? { success: true, data: result.data.frontmost } : result;
	}

	async function health(): DriverResult<HealthInfo> {
		const result = await client.request("health");
		if (!result.success) return result;
		const d = result.data;
		return {
			success: true,
			data: {
				platform: "ios",
				id: udid,
				version: d.version,
				transport: d.hid.transport,
				bridge: d.ax.bridge === "degraded" ? "available" : d.ax.bridge,
				screen: d.screen,
				detail: {
					axDefault: d.ax.default,
					...(d.ax.bridge === "degraded" ? { axBridge: "degraded" } : {}),
					...(d.ax.lastError ? { axLastError: d.ax.lastError } : {}),
					...(d.ax.error !== undefined ? { axError: d.ax.error } : {}),
					...(d.socket ? { socket: d.socket } : {}),
					...(d.xcode ? { xcode: d.xcode } : {}),
					...(d.state ? { state: d.state } : {}),
				},
			},
		};
	}

	async function orientation(set?: Orientation): DriverResult<Orientation> {
		const result = await client.request("orientation", params({ set }));
		if (!result.success) return result;
		const { orientation: read, source } = result.data;
		if (source !== undefined && source !== "device")
			opts.log?.(`[ios] orientation ${read} is ${source}, not read from the device`);
		if (read === "faceUp" || read === "faceDown" || read === "unknown") {
			// Orientation is frozen at the four interface orientations; a flat device has no better answer than upright.
			opts.log?.(`[ios] device reports ${read}; exposing it as portrait`);
			return { success: true, data: "portrait" };
		}
		return { success: true, data: read };
	}

	async function pressButton(button: HardwareButton): DriverResult<void> {
		if (button === "back") return fail(driverError("E_UNSUPPORTED", "iOS has no hardware back button"));
		return sendVoid("pressButton", { button: BUTTONS[button] });
	}

	const driver: IosDriver = {
		platform: "ios",
		id: udid,
		capabilities,
		health,
		snapshot,
		async elementAtPoint(point, o) {
			const result = await client.request(
				"elementAtPoint",
				params({ x: point.x, y: point.y, reachability: o?.reachability })
			);
			if (!result.success) return result;
			return {
				success: true,
				data: result.data === null ? null : normalizeElement(result.data, client.ready.screen),
			};
		},
		tap: (point, o) => sendVoid("tap", params({ x: point.x, y: point.y, count: o?.count, durationMs: o?.durationMs })),
		longPress: (point, o) =>
			sendVoid(
				"longPress",
				params({ x: point.x, y: point.y, durationMs: o?.durationMs }),
				gestureTimeout(o?.durationMs, 1_000)
			),
		swipe: (from, to, o) =>
			sendVoid(
				"swipe",
				params({ from, to, durationMs: o?.durationMs, momentum: o?.momentum }),
				gestureTimeout(o?.durationMs, 300)
			),
		drag: (from, to, o) =>
			sendVoid(
				"drag",
				params({ from, to, pressMs: o?.pressMs, durationMs: o?.durationMs, releaseMs: o?.releaseMs }),
				gestureTimeout((o?.pressMs ?? 0) + (o?.durationMs ?? 0) + (o?.releaseMs ?? 0), 300)
			),
		pinch: (center, scale, o) =>
			sendVoid(
				"pinch",
				params({ center, scale, durationMs: o?.durationMs, radius: o?.radius }),
				gestureTimeout(o?.durationMs, 300)
			),
		typeText,
		key: (key, modifiers) => sendVoid("key", params({ usage: KEY_USAGE[key], modifiers: modifiers && [...modifiers] })),
		selectAll: () => sendVoid("selectAll"),
		pressButton,
		screenshot,
		orientation,
		settle,
		alert,
		alertOn,
		isFrontmost,
		appearance: (set) => simctl.appearance(set),
		async clipboard(set) {
			if (set === undefined) return simctl.pbpaste();
			const copied = await simctl.pbcopy(set);
			return copied.success ? { success: true, data: set } : copied;
		},
		app: {
			launch: async (bundleId, o) => {
				const launched = await simctl.launch(bundleId, o);
				if (launched.success) launchedBundle = bundleId;
				return launched;
			},
			terminate: async (bundleId) => {
				const terminated = await simctl.terminate(bundleId);
				if (terminated.success && launchedBundle === bundleId) launchedBundle = undefined;
				return terminated;
			},
			openUrl: (url) => simctl.openUrl(url),
			install: (path) => simctl.install(path),
			uninstall: (bundleId) => simctl.uninstall(bundleId),
			isInstalled: (bundleId) => simctl.isInstalled(bundleId),
			isRunning: (bundleId) => simctl.isRunning(bundleId),
			clearData: (bundleId, o) => simctl.clearData(bundleId, o),
		},
		close: () => client.close(),
	};
	return driver;
}

const timeoutOption = (o: OpenIosDriverOptions) => (o.defaultTimeoutMs ? { defaultTimeoutMs: o.defaultTimeoutMs } : {});

/** The pre-warmed daemon, when a socket is configured and answers; undefined means "spawn instead". */
async function trySocket(o: OpenIosDriverOptions, log: Logger): Promise<SimdClient | undefined> {
	const socketPath = o.socketPath ?? o.env?.simdSocket;
	if (!socketPath) return undefined;
	const viaSocket = await connectSimd({ socketPath, log, ...timeoutOption(o) });
	if (viaSocket.success) return viaSocket.data;
	log(`[ios] ${viaSocket.error.message}; spawning a helper on stdio instead`);
	return undefined;
}

/** The helper binary: the explicit `helperPath`, else `locateHelper` over the env / install locations. */
export function resolveHelper(o: OpenIosDriverOptions): Result<string, DriverError> {
	if (o.helperPath !== undefined) return { success: true, data: o.helperPath };
	const located = locateHelper({
		env: { [ENV_NAMES.simd]: o.env?.simd, [ENV_NAMES.helperDir]: o.env?.helperDir },
		execPath: o.execPath ?? process.execPath,
		importDir: o.importDir ?? import.meta.dir,
		wardenHome: o.wardenHome ?? resolveWardenHome(),
		exists: o.exists ?? existsSync,
		realpath: o.realpath ?? realpathSync,
		...(o.version ? { version: o.version } : {}),
	});
	return located.success ? { success: true, data: located.data.path } : located;
}

async function connect(o: OpenIosDriverOptions, log: Logger): Promise<Result<SimdClient, DriverError>> {
	const socket = await trySocket(o, log);
	if (socket) return { success: true, data: socket };
	const helper = resolveHelper(o);
	if (!helper.success) return helper;
	const resources = join(dirname(helper.data), "Resources");
	return spawnSimd({
		helperPath: helper.data,
		udid: o.udid,
		log,
		...((o.exists ?? existsSync)(resources) ? { resources } : {}),
		...(o.spawn ? { spawn: o.spawn } : {}),
		...timeoutOption(o),
	});
}

/**
 * Open the iOS driver for `udid`. Writes `AutomationEnabled` (best effort) while the helper starts.
 * `E_HELPER_MISSING` (with the `warden doctor` hint) when no helper binary can be found.
 */
export async function openIosDriver(o: OpenIosDriverOptions): DriverResult<Driver> {
	const log: Logger = o.log ?? (() => undefined);
	const now = o.now ?? Date.now;
	const exec = o.debug ? timedExec(o.exec, log, now) : o.exec;
	const simctl = createSimctl({ udid: o.udid, exec, ...(o.devicesRoot ? { devicesRoot: o.devicesRoot } : {}) });
	// a driver that cannot start (no socket, no helper binary) fails before any simctl call: the AutomationEnabled
	// write takes seconds on a cold machine and would only delay the E_HELPER_MISSING answer
	if (!o.client && !(o.socketPath ?? o.env?.simdSocket)) {
		const helper = resolveHelper(o);
		if (!helper.success) return helper;
	}
	const connecting: Promise<Result<SimdClient, DriverError>> = o.client
		? Promise.resolve({ success: true, data: o.client })
		: connect(o, log);
	const [client, automation] = await Promise.all([connecting, simctl.enableAutomation()]);
	if (!automation.success) log(`[ios] could not enable AX automation: ${automation.error.message}`);
	if (!client.success) return client;
	const swap = swappableClient(client.data, {
		now,
		log,
		reopen: () => connect(o, log),
		...(o.debug ? { debug: true } : {}),
	});
	return {
		success: true,
		data: createIosDriver(swap, simctl, { udid: o.udid, now, sleep: o.sleep ?? ((ms) => Bun.sleep(ms)), log }),
	};
}

/** `[ios] exec xcrun simctl launch 270 ms (exit 0)` for every simctl call. */
function timedExec(exec: Exec, log: Logger, now: () => number): Exec {
	return async (cmd, opts) => {
		const started = now();
		const res = await exec(cmd, opts);
		const label = cmd[0] === "sh" ? "sh (pbcopy)" : cmd.slice(0, 3).join(" ");
		log(`[ios] exec ${label} ${Math.round(now() - started)} ms (exit ${res.exitCode})`);
		return res;
	};
}
