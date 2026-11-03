import { writeFile } from "node:fs/promises";
import type { Exec } from "@delacour/warden-core/exec";
import type { Result } from "@delacour/warden-types/result";
import type { E2eEnv } from "../../../env";
import type { AlertBackend, ProbesFrontmost, ReadsAlertOn } from "../../alerts";
import type {
	AlertInfo,
	Driver,
	DriverError,
	DriverResult,
	Element,
	HardwareButton,
	HealthInfo,
	Logger,
	Orientation,
	Point,
	Snapshot,
} from "../../driver.types";
import { driverError } from "../../errors";
import { physicalConditionOps } from "../../physical-conditions";
import { type SettleDetail, settleByHash, snapshotHash } from "../../settle";
import { noteSpanDetail } from "../../span-detail";
import { KEY_USAGE } from "../ios-driver";
import { normalizeElements, toSnapshot } from "../normalize";
import { connectSimd, type RequestOptions, type SimdClient } from "../simd-client";
import type { AlertButtonsData, OpData } from "../simd-protocol";
import { deviceTypeTextBudgetMs } from "../type-budget";
import { IOS_DEVICE_CAPABILITIES } from "./capabilities";
import { createDevicectl, type Devicectl } from "./devicectl";
import { isRunning, parseAppState } from "./runner-protocol";

/**
 * The `Driver` for a physical iPhone / iPad: input, accessibility and app lifecycle through `warden-runner` (the
 * XCUITest server `warden __ios-runner-host` keeps running on the phone, spoken to over the host's unix socket in the
 * `warden-simd` protocol, so the client, normalizer and alert reader are simd's), and `xcrun devicectl` for what the
 * runner cannot do: install / uninstall / probe, orientation changes, appearance and pasteboard reads, the screenshot
 * fallback. There is no select-all or paste (a field is cleared with counted Backspace), no native settle (snapshot
 * hashes), no multi-touch, and nothing that changes a phone beyond the app under test: an uninstall or data wipe of
 * a bundle warden did not install is `E_REFUSED`.
 */

export type IosDeviceEnv = Pick<E2eEnv, "iosRunnerSocket" | "appPath" | "bundleId">;

export type OpenIosDeviceDriverOptions = {
	udid: string;
	exec: Exec;
	env?: Partial<IosDeviceEnv>;
	/** the runner host's socket (wins over `env.iosRunnerSocket`) */
	socketPath?: string;
	/** an already connected client: used instead of connecting; the driver owns it from here */
	client?: SimdClient;
	/** `WARDEN_BUNDLE_ID`: the app under test, always allowed to be uninstalled / wiped */
	bundleId?: string;
	/** `WARDEN_APP_PATH`: what `clearData` reinstalls */
	appPath?: string;
	/** bundles warden installed on this phone earlier (the `installs` table) */
	ownedBundles?: readonly string[];
	log?: Logger;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	defaultTimeoutMs?: number;
	/** test seams */
	devicectl?: Devicectl;
	writeFile?: (path: string, bytes: Uint8Array) => Promise<void>;
};

export type IosDeviceDriver = Driver & ReadsAlertOn & ProbesFrontmost;

const DEFAULT_QUIET_MS = 250;
const DEFAULT_SETTLE_TIMEOUT_MS = 5_000;
const GESTURE_MARGIN_MS = 5_000;
const LAUNCH_TIMEOUT_MS = 30_000;
const APP_OP_TIMEOUT_MS = 15_000;
const FRONTMOST_TIMEOUT_MS = 3_000;

/** Runner screenshot failures after which devicectl is worth a try (the op missing or failing, not a dead runner). */
const SCREENSHOT_FALLBACK: ReadonlySet<string> = new Set(["E_UNSUPPORTED", "E_IO", "E_INTERNAL"]);

type Params = Record<string, unknown>;

function params(values: Record<string, unknown>): Params {
	return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

const okVoid = { success: true as const, data: undefined };

function fail(error: DriverError) {
	return { success: false as const, error };
}

const unsupported = (what: string, why: string) =>
	fail(driverError("E_UNSUPPORTED", `${what} is not available on a physical iPhone: ${why}`));

class DriverFailure extends Error {
	constructor(readonly error: DriverError) {
		super(error.message);
	}
}

/** The last element (deepest, topmost in preorder) whose frame holds `point`, ignoring hidden ones. */
function hitTest(snapshot: Snapshot, point: Point): Element | null {
	let hit: Element | null = null;
	for (const element of snapshot.flat) {
		if (element.hidden === true) continue;
		const { x, y, width, height } = element.frame;
		if (point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height) hit = element;
	}
	return hit;
}

const gestureTimeout = (durationMs: number | undefined, base = 0) => (durationMs ?? 0) + base + GESTURE_MARGIN_MS;

export function createIosDeviceDriver(
	client: SimdClient,
	devicectl: Devicectl,
	opts: Omit<OpenIosDeviceDriverOptions, "client" | "exec" | "devicectl" | "env" | "socketPath"> & {
		now: () => number;
		sleep: (ms: number) => Promise<void>;
		write: (path: string, bytes: Uint8Array) => Promise<void>;
	}
): IosDeviceDriver {
	const { udid, now, sleep } = opts;
	/** bundles this session may uninstall: the app under test, earlier installs, and what this driver installed */
	const owned = new Set<string>([...(opts.ownedBundles ?? []), ...(opts.bundleId ? [opts.bundleId] : [])]);

	async function request<Op extends string>(op: Op, p: Params = {}, o: RequestOptions = {}): DriverResult<OpData<Op>> {
		return client.request(op, p, o);
	}

	const sendVoid = async (op: string, p: Params = {}, timeoutMs?: number): DriverResult<void> => {
		const result = await request(op, p, timeoutMs === undefined ? {} : { timeoutMs });
		return result.success ? okVoid : result;
	};

	async function snapshot(o?: { interactiveOnly?: boolean; backend?: Snapshot["backend"] }): DriverResult<Snapshot> {
		const result = await request("snapshot", params({ interactiveOnly: o?.interactiveOnly, backend: o?.backend }));
		if (!result.success) return result;
		const { fallback } = result.data;
		if (fallback) opts.log?.(`[ios-device] snapshot fell back ${fallback.from} -> ${fallback.to}: ${fallback.reason}`);
		return { success: true, data: toSnapshot(result.data, now()) };
	}

	async function settle(o: { quietMs?: number; timeoutMs?: number } = {}): DriverResult<SettleDetail> {
		try {
			const outcome = await settleByHash(
				async () => {
					const snap = await snapshot();
					if (!snap.success) throw new DriverFailure(snap.error);
					return snapshotHash(snap.data);
				},
				{ quietMs: o.quietMs ?? DEFAULT_QUIET_MS, timeoutMs: o.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS, now, sleep }
			);
			noteSpanDetail("via", "hash");
			return { success: true, data: { ...outcome, via: "hash" } };
		} catch (error) {
			if (error instanceof DriverFailure) return fail(error.error);
			throw error;
		}
	}

	async function screenshot(o?: { path?: string; scale?: number }): DriverResult<{ path?: string; png?: Uint8Array }> {
		const viaRunner = await request("screenshot", params({ scale: o?.scale }));
		if (viaRunner.success) {
			const { png } = viaRunner.data;
			if (png === undefined) return fail(driverError("E_INTERNAL", "warden-runner screenshot returned no png"));
			const bytes = new Uint8Array(Buffer.from(png, "base64"));
			if (o?.path === undefined) return { success: true, data: { png: bytes } };
			await opts.write(o.path, bytes);
			return { success: true, data: { path: o.path } };
		}
		if (!SCREENSHOT_FALLBACK.has(viaRunner.error.code)) return viaRunner;
		opts.log?.(`[ios-device] runner screenshot failed (${viaRunner.error.code}), using devicectl`);
		return devicectl.screenshot(o?.path);
	}

	async function readOrientation(): DriverResult<Orientation> {
		const result = await request("orientation");
		if (!result.success) return result;
		const read = result.data.orientation;
		if (read === "faceUp" || read === "faceDown" || read === "unknown") return { success: true, data: "portrait" };
		return { success: true, data: read };
	}

	async function orientation(set?: Orientation): DriverResult<Orientation> {
		if (set !== undefined) {
			const changed = await devicectl.setOrientation(set);
			if (!changed.success) return changed;
		}
		return readOrientation();
	}

	function toAlertInfo(data: NonNullable<AlertButtonsData>): AlertInfo {
		const { title, message, buttons } = data;
		const info: AlertInfo = { buttons: normalizeElements(buttons, client.ready.screen).elements };
		if (title !== undefined) info.title = title;
		if (message !== undefined) info.message = message;
		return info;
	}

	async function alert(): DriverResult<AlertInfo | null> {
		const result = await request("alertButtons");
		if (!result.success) return result;
		return { success: true, data: result.data === null ? null : toAlertInfo(result.data) };
	}

	async function isFrontmost(bundleId: string): DriverResult<boolean> {
		const result = await request("frontmost", { bundleId }, { timeoutMs: FRONTMOST_TIMEOUT_MS });
		return result.success ? { success: true, data: result.data.frontmost } : result;
	}

	async function health(): DriverResult<HealthInfo> {
		const result = await request("health");
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
				detail: { axDefault: d.ax.default, ...(d.state ? { state: d.state } : {}) },
			},
		};
	}

	async function pressButton(button: HardwareButton): DriverResult<void> {
		if (button === "back") return fail(driverError("E_UNSUPPORTED", "iOS has no hardware back button"));
		if (button === "shake") return unsupported("shake", "the XCUITest runner cannot shake the phone");
		return sendVoid("pressButton", { button });
	}

	async function clipboard(set?: string): DriverResult<string> {
		if (set === undefined) return devicectl.pasteboardPaste();
		const copied = await devicectl.pasteboardCopy(set);
		if (!copied.success) return copied;
		const back = await devicectl.pasteboardPaste();
		if (!back.success) return back;
		if (back.data !== set) {
			return fail(driverError("E_IO", "devicectl pasteboard copy exited 0 but the pasteboard does not hold the text"));
		}
		return { success: true, data: set };
	}

	/** The refusal for a bundle warden did not install; a phone is somebody's, only warden's own installs are touched. */
	function guard(bundleId: string, action: "uninstall" | "clear the data of"): DriverError | undefined {
		if (owned.has(bundleId)) return undefined;
		return driverError(
			"E_REFUSED",
			`physical_protected: ${bundleId} was not installed by warden; refusing to ${action} it on physical device ${udid}`,
			{ retryable: false, detail: { reason: "physical_protected", bundleId } }
		);
	}

	async function install(path: string): DriverResult<void> {
		const installed = await devicectl.install(path);
		if (!installed.success) return installed;
		for (const bundleId of installed.data.bundleIds) owned.add(bundleId);
		return okVoid;
	}

	async function uninstall(bundleId: string): DriverResult<void> {
		const refused = guard(bundleId, "uninstall");
		return refused ? fail(refused) : devicectl.uninstall(bundleId);
	}

	/** uninstall + reinstall from `WARDEN_APP_PATH`: the keychain survives an uninstall on iOS, so only the sandbox is wiped */
	async function clearData(bundleId: string): DriverResult<void> {
		const refused = guard(bundleId, "clear the data of");
		if (refused) return fail(refused);
		if (opts.appPath === undefined) {
			return fail(
				driverError("E_BAD_REQUEST", "clearData reinstalls the app and needs WARDEN_APP_PATH (the build to put back)")
			);
		}
		const removed = await devicectl.uninstall(bundleId);
		if (!removed.success) return removed;
		noteSpanDetail("keychainKept", true);
		opts.log?.(`[ios-device] clearData(${bundleId}): reinstalled; the keychain items of the app were kept`);
		return install(opts.appPath);
	}

	return {
		platform: "ios",
		id: udid,
		capabilities: IOS_DEVICE_CAPABILITIES,
		health,
		snapshot,
		async elementAtPoint(point) {
			const snap = await snapshot();
			return snap.success ? { success: true, data: hitTest(snap.data, point) } : snap;
		},
		tap: (point, o) => sendVoid("tap", params({ x: point.x, y: point.y, count: o?.count, durationMs: o?.durationMs })),
		longPress: (point, o) =>
			sendVoid(
				"longPress",
				params({ x: point.x, y: point.y, durationMs: o?.durationMs }),
				gestureTimeout(o?.durationMs, 1_000)
			),
		swipe: (from, to, o) =>
			sendVoid("swipe", params({ from, to, durationMs: o?.durationMs }), gestureTimeout(o?.durationMs, 300)),
		drag: (from, to, o) =>
			sendVoid(
				"drag",
				params({ from, to, pressMs: o?.pressMs, durationMs: o?.durationMs, releaseMs: o?.releaseMs }),
				gestureTimeout((o?.pressMs ?? 0) + (o?.durationMs ?? 0) + (o?.releaseMs ?? 0), 300)
			),
		pinch: async () => unsupported("pinch", "the XCUITest runner takes one finger"),
		rotate: async () => unsupported("rotate", "the XCUITest runner takes one finger"),
		gesture: async () => unsupported("gesture", "the XCUITest runner takes taps, swipes and drags only"),
		biometrics: async () =>
			unsupported("biometrics", "Face ID / Touch ID cannot be simulated on a real sensor; use a simulator"),
		...physicalConditionOps(`physical iPhone ${udid}`),
		typeText: (text) => sendVoid("typeText", { text }, deviceTypeTextBudgetMs(text)),
		key: (key, modifiers) => sendVoid("key", params({ usage: KEY_USAGE[key], modifiers: modifiers && [...modifiers] })),
		pressButton,
		screenshot,
		orientation,
		settle,
		alert,
		alertOn: (_backend: AlertBackend) => alert(),
		isFrontmost,
		async appearance(set) {
			if (set !== undefined) {
				return fail(
					driverError(
						"E_REFUSED",
						`physical_protected: changing the appearance is a persistent settings write on physical device ${udid}`,
						{ retryable: false, detail: { reason: "physical_protected" } }
					)
				);
			}
			return devicectl.appearance();
		},
		clipboard,
		app: {
			launch: (bundleId, o) =>
				sendVoid(
					"launch",
					params({ bundleId, args: o?.args && [...o.args], env: o?.env, terminateRunning: o?.relaunch !== false }),
					LAUNCH_TIMEOUT_MS
				),
			terminate: (bundleId) => sendVoid("terminate", { bundleId }, APP_OP_TIMEOUT_MS),
			openUrl: (url) => sendVoid("openUrl", { url }, APP_OP_TIMEOUT_MS),
			install,
			uninstall,
			isInstalled: (bundleId) => devicectl.isInstalled(bundleId),
			async isRunning(bundleId) {
				const result = await request("appState", { bundleId });
				if (!result.success) return result;
				const state = parseAppState(result.data);
				if (state === undefined) return fail(driverError("E_INTERNAL", "warden-runner appState returned no state"));
				return { success: true, data: isRunning(state) };
			},
			clearData: (bundleId) => clearData(bundleId),
		},
		close: () => client.close(),
	};
}

/** The runner host's client: the given one, else a connection to its socket; `E_HELPER_MISSING` with neither. */
async function runnerClient(o: OpenIosDeviceDriverOptions, log: Logger): Promise<Result<SimdClient, DriverError>> {
	if (o.client) return { success: true, data: o.client };
	const socketPath = o.socketPath ?? o.env?.iosRunnerSocket;
	if (!socketPath) {
		return fail(
			driverError(
				"E_HELPER_MISSING",
				`no iOS runner for ${o.udid}: WARDEN_IOS_RUNNER_SOCKET is not set (warden starts the runner host with \`warden ui\` / \`warden e2e\`)`
			)
		);
	}
	return connectSimd({ socketPath, log, ...(o.defaultTimeoutMs ? { defaultTimeoutMs: o.defaultTimeoutMs } : {}) });
}

/**
 * Open the driver for the phone `udid` against its runner host's socket (`socketPath` / `env.iosRunnerSocket` /
 * `client`). `E_HELPER_MISSING` without any: the host is started by `warden ui` / `warden e2e`, never by the driver.
 */
export async function openIosDeviceDriver(o: OpenIosDeviceDriverOptions): DriverResult<Driver> {
	const log: Logger = o.log ?? (() => undefined);
	const client = await runnerClient(o, log);
	if (!client.success) return client;
	const bundleId = o.bundleId ?? o.env?.bundleId;
	const appPath = o.appPath ?? o.env?.appPath;
	const devicectl = o.devicectl ?? createDevicectl({ udid: o.udid, exec: o.exec });
	return {
		success: true,
		data: createIosDeviceDriver(client.data, devicectl, {
			udid: o.udid,
			log,
			now: o.now ?? Date.now,
			sleep: o.sleep ?? ((ms) => Bun.sleep(ms)),
			write: o.writeFile ?? ((path, bytes) => writeFile(path, bytes)),
			...(bundleId ? { bundleId } : {}),
			...(appPath ? { appPath } : {}),
			...(o.ownedBundles ? { ownedBundles: o.ownedBundles } : {}),
		}),
	};
}
