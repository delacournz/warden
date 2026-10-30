import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	launchSettingsPath,
	readLaunchSettings,
	writeLaunchSettings,
} from "@delacour/warden-core/conditions/launch-settings";
import type { Exec } from "@delacour/warden-core/exec";
import { wardenHome as resolveWardenHome } from "@delacour/warden-core/store";
import { ok, type Result } from "@delacour/warden-types/result";
import type { E2eEnv } from "../../env";
import type { AlertBackend, ProbesFrontmost, ReadsAlertOn } from "../alerts";
import type { ClockRecorder } from "../clock-recorder";
import type {
	AlertInfo,
	Driver,
	DriverCapabilities,
	DriverError,
	DriverResult,
	HardwareButton,
	HealthInfo,
	KeyName,
	LaunchOptions,
	Logger,
	Orientation,
	Snapshot,
} from "../driver.types";
import { driverErr, driverError } from "../errors";
import { DEFAULT_RADIUS, type GesturePlan, planGesture, rotatePlan } from "../gesture-geometry";
import type { NetworkProxyPort } from "../network-proxy";
import { type SettleDetail, settleByHash, snapshotHash } from "../settle";
import { noteSpanDetail } from "../span-detail";
import type { PastesText, SelectsAll } from "../typing";
import { createInjectChannel, INJECT_DYLIB_ENV, type InjectFs, injectStatePath, locateInjectDylib } from "./inject";
import { createIosNetwork, type IosNetwork } from "./ios-network";
import { type SwappableClient, swappableClient } from "./ios-session";
import { createIosSettings, type IosSettings, type StagedSettings, withStagedSettings } from "./ios-settings";
import { resolveHelper } from "./locate-helper";
import { normalizeElement, normalizeElements, toSnapshot } from "./normalize";
import { createSimctl, type Simctl } from "./simctl";
import { connectSimd, type RequestOptions, type SimdClient, spawnSimd } from "./simd-client";
import type { AlertButtonsData, HealthData, OpData, RebindData, SettleData } from "./simd-protocol";
import type { SimdSpawn } from "./simd-transport";
import { typeTextBudgetMs } from "./type-budget";

/**
 * The iOS `Driver`: input, AX and app launch / terminate / openUrl through `warden-simd` (socket when
 * `WARDEN_SIMD_SOCKET` is set, else a helper spawned on stdio); install / uninstall / isRunning / clearData,
 * clipboard and appearance through `xcrun simctl`. Fallbacks: `typeText` pastes what the HID keyboard map
 * cannot type, `settle` polls snapshot hashes when the helper has no native quiescence, `screenshot` uses
 * `simctl io` when the helper cannot, and a helper built before the app ops leaves app lifecycle to `simctl`.
 */

export type IosDriverEnv = Pick<E2eEnv, "simd" | "simdSocket" | "helperDir">;

/** The iOS driver is a `Driver` plus the optional capabilities of `driver/alerts.ts`. */
export type IosDriver = Driver & SelectsAll & PastesText & ReadsAlertOn & ProbesFrontmost;

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
	/**
	 * The lease's shaping proxy (`leaseNetworkProxy`). Without it `network` / `networkFaults` answer `E_UNSUPPORTED`:
	 * a driver opened by a bare caller has no lease to hang a proxy on.
	 */
	networkProxy?: NetworkProxyPort;
	/** told about every successful `clock` op, so the lease records the `clock` area (`leaseClockRecorder`) */
	clockRecorder?: ClockRecorder;
	/** the session's app (`WARDEN_BUNDLE_ID`): the default target of permissions, push and locale */
	bundleId?: string;
	/** where a staged timezone / locale is kept between processes (default: `<wardenHome>/launch-settings/<udid>.json`) */
	stagedSettings?: StagedSettings;
	/** state-file operations of the injected dylib's control channel, injected for tests */
	injectFs?: InjectFs;
	/** CoreSimulator devices directory for the host-side `AutomationEnabled` check (default `~/Library/Developer/CoreSimulator/Devices`) */
	devicesRoot?: string;
};

const DEFAULT_QUIET_MS = 250;
const DEFAULT_SETTLE_TIMEOUT_MS = 5_000;
const SETTLE_MARGIN_MS = 2_000;
/** How long `app.launch` lets the helper wait for its stream to follow the new process; the helper answers earlier. */
const REBIND_TIMEOUT_MS = 3_000;
const GESTURE_MARGIN_MS = 5_000;
/** `frontmost` is one launchd lookup; a helper that has not answered in this long is busy, and the caller carries on without. */
const FRONTMOST_TIMEOUT_MS = 3_000;
/** The helper's `launch` waits for the app to start, bounded like `simctl launch` was. */
const LAUNCH_TIMEOUT_MS = 30_000;
/** `terminate` / `openUrl` through the helper. */
const APP_OP_TIMEOUT_MS = 15_000;

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

/**
 * Reads asked once more after a lost helper was replaced (03-1). Input ops are never re-sent: the lost
 * helper may already have delivered them, so their `E_HELPER_CRASHED` goes back to the caller unchanged.
 */
const RETRIED_AFTER_CRASH: ReadonlySet<string> = new Set([
	"snapshot",
	"health",
	"alertButtons",
	"frontmost",
	"settle",
	"elementAtPoint",
	"screenshot",
]);

/** How long `connect` waits before asking a configured socket a second time (20-1). */
const SOCKET_RETRY_MS = 500;

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

/** Leaves the helper's rebind verdict on the current span. */
function noteRebind(data: RebindData): void {
	noteSpanDetail("rebind", data.bound ? "bound" : (data.reason ?? "unbound"));
	noteSpanDetail("rebindMs", data.waitedMs);
	if (data.restarts !== undefined && data.restarts > 0) noteSpanDetail("rebindRestarts", data.restarts);
	if (data.recycled === true) noteSpanDetail("rebindRecycled", true);
}

/** The `detail` of a `health` reply: only the helper fields that are present. */
function healthDetail(d: HealthData): Record<string, unknown> {
	return {
		axDefault: d.ax.default,
		...(d.ax.bridge === "degraded" ? { axBridge: "degraded" } : {}),
		...(d.ax.lastError ? { axLastError: d.ax.lastError } : {}),
		...(d.ax.error !== undefined ? { axError: d.ax.error } : {}),
		...(d.socket ? { socket: d.socket } : {}),
		...(d.xcode ? { xcode: d.xcode } : {}),
		...(d.state ? { state: d.state } : {}),
	};
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

/** A helper built before an op answers `E_UNSUPPORTED`, or the dispatcher's `E_BAD_REQUEST unknown op`. */
function predatesOp(error: DriverError): boolean {
	return (
		error.code === "E_UNSUPPORTED" || (error.code === "E_BAD_REQUEST" && /unknown (input )?op/.test(error.message))
	);
}

type AppOp = "launch" | "terminate" | "openUrl";

/** `requested` with the injected dylib's env merged in, when the lease has a network or clock condition. */
async function launchWithInjection(
	net: IosNetwork | undefined,
	requested: LaunchOptions | undefined
): Promise<Result<LaunchOptions | undefined, DriverError>> {
	const injected = net ? await net.launchEnv(requested ?? {}) : undefined;
	if (injected && !injected.success) return injected;
	const env = injected?.data;
	return { success: true, data: env ? { ...requested, env: { ...requested?.env, ...env } } : requested };
}

export function createIosDriver(
	swap: SwappableClient,
	simctl: Simctl,
	opts: {
		udid: string;
		now: () => number;
		sleep: (ms: number) => Promise<void>;
		log?: Logger;
		/** told about every successful `clock` op */
		clockRecorder?: ClockRecorder;
		/** device settings (`ios-settings.ts`); absent: those ops answer `E_UNSUPPORTED` */
		settings?: (ctx: { lastBundle: () => string | undefined }) => IosSettings;
		/** per-app network conditions (`ios-network.ts`); absent: `network` answers `E_UNSUPPORTED` */
		network?: (deps: {
			lastBundle: () => string | undefined;
			relaunch: (bundleId: string) => DriverResult<void>;
		}) => IosNetwork;
	}
): IosDriver {
	const { udid, now, sleep } = opts;
	let lastLaunched: string | undefined;
	const noLeaseProxy = async () =>
		driverErr(
			"E_UNSUPPORTED",
			"network and clock conditions on iOS need a device lease for the shaping proxy: run the spec with `warden e2e` (it sets WARDEN_LEASE_ID), or `warden ui`; a bare `bun test` has no lease"
		);
	const settings = opts.settings?.({ lastBundle: () => lastLaunched });
	const noSettings = async () =>
		driverErr("E_UNSUPPORTED", "this iOS driver was opened without device settings support");
	// late-bound: the network helper relaunches through the driver's own `app.launch`
	let driverRef: IosDriver | undefined;
	const net = opts.network?.({
		lastBundle: () => lastLaunched,
		relaunch: (bundleId) =>
			driverRef ? driverRef.app.launch(bundleId, { relaunch: true, inject: true }) : noLeaseProxy(),
	});
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
	let rebindUnsupported = false;
	let gestureUnsupported = false;
	/** set once the helper did not know an app lifecycle op: it predates them, and `simctl` does app lifecycle */
	let appOpsOutdated = false;

	const capabilities: DriverCapabilities = {
		pinch: true,
		maxPointers: 2,
		unicodeText: true,
		nativeSettle,
		alerts: true,
		reachability: true,
		cheapHitTest: true,
	};

	/**
	 * Set once a lost helper could not be replaced: every later call answers it at once, not retryable, rather
	 * than paying a connect and a spawn each time or having each look poll a dead client until its timeout.
	 */
	let lost: DriverError | undefined;
	/** the generation of the helper that last answered; one reconnect per helper that answered, so a crash loop stops */
	let answeredGeneration = swap.generation();

	/**
	 * Replace the helper that went away under generation `seen`, once. Undefined: go on (replaced now, or by a
	 * concurrent caller); else the error to return (a helper that never answered since its replacement is not
	 * replaced again, so a crash loop stops).
	 */
	async function replaceLost(op: string, seen: number, crash: DriverError): Promise<DriverError | undefined> {
		if (seen !== swap.generation()) return undefined;
		if (seen !== answeredGeneration) return crash;
		opts.log?.(`[ios] warden-simd went away during \`${op}\` (E_HELPER_CRASHED: ${crash.message}); reconnecting`);
		const restarted = await swap.restart(seen, { crashed: true });
		if (restarted.success) return undefined;
		const why = `${restarted.error.code}: ${restarted.error.message}`;
		opts.log?.(`[ios] could not replace warden-simd (${why})`);
		lost ??= driverError("E_HELPER_CRASHED", `${crash.message}; could not replace it (${why})`, { retryable: false });
		return lost;
	}

	/**
	 * Every helper request. `E_HELPER_CRASHED` (the helper exited or the socket daemon's connection closed) is
	 * answered like a stale bridge: the helper is replaced once (`swap.restart`, socket first, else a stdio
	 * spawn) and a read is asked again; an input op's error is returned unchanged, the next call uses the new helper.
	 */
	async function request<Op extends string>(op: Op, p: Params = {}, o: RequestOptions = {}): DriverResult<OpData<Op>> {
		if (lost) return fail(lost);
		const seen = swap.generation();
		const first = await client.request(op, p, o);
		if (first.success) {
			answeredGeneration = seen;
			return first;
		}
		if (first.error.code !== "E_HELPER_CRASHED") return first;
		const stop = await replaceLost(op, seen, first.error);
		if (stop) return fail(stop);
		if (!RETRIED_AFTER_CRASH.has(op)) return first;
		const generation = swap.generation();
		const again = await client.request(op, p, o);
		if (again.success) answeredGeneration = generation;
		return again;
	}

	const send = (op: string, p: Params = {}, timeoutMs?: number) =>
		request(op, p, timeoutMs === undefined ? {} : { timeoutMs });

	const sendVoid = async (op: string, p: Params = {}, timeoutMs?: number): DriverResult<void> => {
		const result = await send(op, p, timeoutMs);
		return result.success ? okVoid : result;
	};

	const gestureTimeout = (durationMs: number | undefined, base = 0) => (durationMs ?? 0) + base + GESTURE_MARGIN_MS;

	const helperOutdated = () =>
		fail(
			driverError(
				"E_UNSUPPORTED",
				`this warden-simd predates the gesture op: restart the helper (warden ui close --udid ${udid}) or rebuild it (bun run --cwd packages/e2e native:build)`,
				{ detail: { reason: "helper_outdated" } }
			)
		);

	/** Replays a plan through the helper's `gesture` op; an old helper that doesn't know the op is remembered. */
	const sendGesture = async (planned: Result<GesturePlan, DriverError>): DriverResult<void> => {
		if (!planned.success) return planned;
		if (gestureUnsupported) return helperOutdated();
		const plan = planned.data;
		const result = await sendVoid(
			"gesture",
			{ paths: plan.paths, frameMs: plan.frameMs, holdMs: plan.holdMs, releaseMs: plan.releaseMs },
			gestureTimeout(plan.totalMs, 300)
		);
		if (!result.success && result.error.code === "E_BAD_REQUEST" && /unknown (input )?op/.test(result.error.message)) {
			gestureUnsupported = true;
			return helperOutdated();
		}
		return result;
	};

	/**
	 * `launch` / `terminate` / `openUrl` through the helper, whose process already holds CoreSimulator: every `xcrun
	 * simctl` start loads it again (~0.13 CPU-s on the host, one per `app.open`). `undefined` means this helper predates
	 * the ops: remembered after the first such answer (logged once), and the caller runs the `simctl` equivalent. Any
	 * other failure is the answer, like a failed `simctl` was.
	 */
	async function appOp<Op extends AppOp>(
		op: Op,
		p: Params,
		timeoutMs: number
	): Promise<Result<OpData<Op>, DriverError> | undefined> {
		if (appOpsOutdated) {
			noteSpanDetail("via", "simctl");
			return undefined;
		}
		const result = await request(op, p, { timeoutMs });
		if (!result.success && predatesOp(result.error)) {
			appOpsOutdated = true;
			noteSpanDetail("via", "simctl");
			noteSpanDetail("reason", "helper_outdated");
			opts.log?.(
				`[ios] this warden-simd predates the \`${op}\` op (${result.error.code}: ${result.error.message}); app lifecycle goes through simctl until the helper is restarted (warden ui close --udid ${udid}) or rebuilt (bun run --cwd packages/e2e native:build)`
			);
			return undefined;
		}
		noteSpanDetail("via", "simd");
		return result;
	}

	/** The outcome of an app op: `fallback` when this helper predates it, else the helper's answer with `note` on its data. */
	async function appOutcome<Data>(
		viaHelper: Result<Data, DriverError> | undefined,
		fallback: () => DriverResult<void>,
		note: (data: Data) => void
	): DriverResult<void> {
		if (viaHelper === undefined) return fallback();
		if (!viaHelper.success) return viaHelper;
		note(viaHelper.data);
		return okVoid;
	}

	const fetchSnapshot = async (o?: { interactiveOnly?: boolean; backend?: Snapshot["backend"] }) => {
		const result = await request("snapshot", params({ interactiveOnly: o?.interactiveOnly, backend: o?.backend }));
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
		opts.log?.(`[ios] typeText: pasting ${rest.length} unmappable character(s)`);
		return pasteText(rest);
	}

	/**
	 * Puts `text` on the simulator pasteboard (confirmed by `pbpaste`) and sends one Cmd+V; a pasteboard write that
	 * cannot be confirmed pastes nothing. A failure is logged (code and message, never the text), because `fill`
	 * types the text instead and the only other trace of it would be a fill that took per-character time.
	 */
	async function pasteText(text: string): DriverResult<void> {
		if (text === "") return ok(undefined);
		const copied = await simctl.pbcopy(text);
		const result = copied.success ? await sendVoid("paste") : copied;
		if (!result.success) opts.log?.(`[ios] pasteText failed (${result.error.code}): ${result.error.message}`);
		return result;
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

	/**
	 * Right after `simctl launch` the helper's quiescence stream still reports on the previous frontmost app; the first
	 * AX read then fails with `did not respond` and the repair costs seconds. `rebind` makes the helper wait (briefly,
	 * and without restarting a stream that follows by itself) until the stream reports on the new process, so the
	 * first read and settle after a launch are fast. Best effort: any failure leaves the launch as it was.
	 */
	async function rebind(bundleId: string): Promise<boolean> {
		if (rebindUnsupported || settleUnsupported) return false;
		const reply = await request(
			"rebind",
			{ bundleId, rebindTimeoutMs: REBIND_TIMEOUT_MS },
			{ timeoutMs: REBIND_TIMEOUT_MS + SETTLE_MARGIN_MS }
		);
		if (!reply.success) {
			if (reply.error.code === "E_UNSUPPORTED" || reply.error.code === "E_BAD_REQUEST") rebindUnsupported = true;
			noteSpanDetail("rebind", reply.error.code);
			opts.log?.(`[ios] rebind after launch failed (${reply.error.code}): ${reply.error.message}`);
			return false;
		}
		noteRebind(reply.data);
		return reply.data.bound;
	}

	/**
	 * The helper's own settle, or undefined when it is unsupported (the caller falls back to polling snapshot hashes).
	 * The helper's budget is `settleTimeoutMs`; the envelope `timeoutMs` is only our padded transport timer.
	 */
	async function settleViaHelper(quietMs: number, timeoutMs: number): Promise<DriverResult<SettleDetail> | undefined> {
		const expected = launchedBundle;
		const native = await request(
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
		return undefined;
	}

	async function settle(o: { quietMs?: number; timeoutMs?: number } = {}): DriverResult<SettleDetail> {
		const quietMs = o.quietMs ?? DEFAULT_QUIET_MS;
		const timeoutMs = o.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
		if (!settleUnsupported) {
			const native = await settleViaHelper(quietMs, timeoutMs);
			if (native) return native;
		}
		return hashSettle({ quietMs, timeoutMs });
	}

	async function screenshot(o?: { path?: string; scale?: number }): DriverResult<{ path?: string; png?: Uint8Array }> {
		const viaHelper = await request("screenshot", params({ path: o?.path, scale: o?.scale }));
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
		const result = await request("alertButtons", params({ backend }));
		if (!result.success) return result;
		return { success: true, data: result.data === null ? null : toAlertInfo(result.data) };
	}

	const alert = (): DriverResult<AlertInfo | null> => readAlert();

	/** Without the bridge `axbridge` has nothing to read: the host reader is the one reader left. */
	const alertOn = (backend: AlertBackend): DriverResult<AlertInfo | null> =>
		readAlert(backend === "axbridge" && !bridgeUp ? "ax" : backend);

	async function isFrontmost(bundleId: string): DriverResult<boolean> {
		if (!bridgeUp) return fail(driverError("E_UNSUPPORTED", "frontmost needs the axbridge backend"));
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
				detail: healthDetail(d),
			},
		};
	}

	async function orientation(set?: Orientation): DriverResult<Orientation> {
		const result = await request("orientation", params({ set }));
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
			const result = await request("elementAtPoint", params({ x: point.x, y: point.y, reachability: o?.reachability }));
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
				params({ center, scale, durationMs: o?.durationMs, radius: o?.radius, angle: o?.angle }),
				gestureTimeout(o?.durationMs, 300)
			),
		rotate: (center, degrees, o) => sendGesture(rotatePlan(center, degrees, o, DEFAULT_RADIUS)),
		gesture: (paths, o) => sendGesture(planGesture(paths, o, 2)),
		typeText,
		key: (key, modifiers) => sendVoid("key", params({ usage: KEY_USAGE[key], modifiers: modifiers && [...modifiers] })),
		selectAll: () => sendVoid("selectAll"),
		pasteText,
		pressButton,
		screenshot,
		orientation,
		settle,
		alert,
		alertOn,
		isFrontmost,
		appearance: (set) => simctl.appearance(set),
		network: async (op, o) => (net ? net.network(op, o) : noLeaseProxy()),
		networkFaults: async (faults) => (net ? net.networkFaults(faults) : noLeaseProxy()),
		location: (op) => simctl.location(op),
		permissions: (grants, o) => (settings ? settings.permissions(grants, o) : noSettings()),
		timezone: (tz, o) => (settings ? settings.timezone(tz, o) : noSettings()),
		locale: (tag, o) => (settings ? settings.locale(tag, o) : noSettings()),
		a11y: (op) => (settings ? settings.a11y(op) : noSettings()),
		battery: (op) => (settings ? settings.battery(op) : noSettings()),
		memoryWarning: (o) => (settings ? settings.memoryWarning(o) : noSettings()),
		push: (payload, o) => (settings ? settings.push(payload, o) : noSettings()),
		async clock(op, o) {
			if (!net) return noLeaseProxy();
			const result = await net.clock(op, o);
			if (result.success) opts.clockRecorder?.(op);
			return result;
		},
		biometrics: (op) => simctl.biometrics(op),
		async clipboard(set) {
			if (set === undefined) return simctl.pbpaste();
			const copied = await simctl.pbcopy(set);
			return copied.success ? { success: true, data: set } : copied;
		},
		app: {
			launch: async (bundleId, plain) => {
				const requested = settings ? withStagedSettings(plain, settings.launchSettings()) : plain;
				const withEnv = await launchWithInjection(net, requested);
				if (!withEnv.success) return withEnv;
				const o = withEnv.data;
				const viaHelper = await appOp(
					"launch",
					params({ bundleId, args: o?.args && [...o.args], env: o?.env, terminateRunning: o?.relaunch !== false }),
					LAUNCH_TIMEOUT_MS
				);
				const launched = await appOutcome(
					viaHelper,
					() => simctl.launch(bundleId, o),
					(data) => noteSpanDetail("pid", data.pid)
				);
				if (launched.success) {
					lastLaunched = bundleId;
					launchedBundle = bundleId;
					if (await rebind(bundleId)) launchedBundle = undefined;
					const loaded = await net?.confirmLoaded();
					if (loaded && !loaded.success) return loaded;
				}
				return launched;
			},
			terminate: async (bundleId) => {
				const viaHelper = await appOp("terminate", { bundleId }, APP_OP_TIMEOUT_MS);
				const terminated = await appOutcome(
					viaHelper,
					() => simctl.terminate(bundleId),
					(data) => noteSpanDetail("terminated", data.terminated)
				);
				if (terminated.success && launchedBundle === bundleId) launchedBundle = undefined;
				return terminated;
			},
			openUrl: async (url) => {
				const viaHelper = await appOp("openUrl", { url }, APP_OP_TIMEOUT_MS);
				return appOutcome(
					viaHelper,
					() => simctl.openUrl(url),
					() => undefined
				);
			},
			install: (path) => simctl.install(path),
			uninstall: (bundleId) => simctl.uninstall(bundleId),
			isInstalled: (bundleId) => simctl.isInstalled(bundleId),
			isRunning: (bundleId) => simctl.isRunning(bundleId),
			clearData: (bundleId, o) => simctl.clearData(bundleId, o),
		},
		close: () => client.close(),
	};
	driverRef = driver;
	return driver;
}

const timeoutOption = (o: OpenIosDriverOptions) => (o.defaultTimeoutMs ? { defaultTimeoutMs: o.defaultTimeoutMs } : {});

/** The pre-warmed daemon, when a socket is configured and answers; undefined means "spawn instead". */
/**
 * A configured socket that does not answer is asked once more after {@link SOCKET_RETRY_MS} (a loaded host, a
 * daemon still starting): a stdio helper next to a live daemon means two quiescence streams on one simulator,
 * which slows every `settle` of both (20-1). A protocol mismatch is not retried.
 */
async function trySocket(o: OpenIosDriverOptions, log: Logger): Promise<SimdClient | undefined> {
	const socketPath = o.socketPath ?? o.env?.simdSocket;
	if (!socketPath) return undefined;
	const first = await connectSimd({ socketPath, log, ...timeoutOption(o) });
	if (first.success) return first.data;
	if (!first.error.retryable) {
		log(`[ios] WARNING: ${first.error.message}; spawning a helper on stdio instead`);
		return undefined;
	}
	log(`[ios] WARNING: ${first.error.message}; retrying once in ${SOCKET_RETRY_MS} ms`);
	await (o.sleep ?? ((ms: number) => Bun.sleep(ms)))(SOCKET_RETRY_MS);
	const second = await connectSimd({ socketPath, log, ...timeoutOption(o) });
	if (second.success) return second.data;
	log(
		`[ios] WARNING: ${second.error.message}; spawning a helper on stdio instead (a live daemon on ${socketPath} would now share the simulator with it)`
	);
	return undefined;
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
	const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
	const network = iosNetworkFactory(o, simctl, now, sleep);
	return {
		success: true,
		data: createIosDriver(swap, simctl, {
			udid: o.udid,
			now,
			sleep,
			log,
			...(network ? { network } : {}),
			settings: (ctx) =>
				createIosSettings({
					udid: o.udid,
					exec,
					lastBundle: ctx.lastBundle,
					...(o.bundleId ? { defaultBundle: o.bundleId } : {}),
					staged: o.stagedSettings ?? stagedSettingsFor(o.wardenHome ?? resolveWardenHome(), o.udid),
				}),
			...(o.clockRecorder ? { clockRecorder: o.clockRecorder } : {}),
		}),
	};
}

/** Timezone / locale staged in a file per device, so a later `warden ui open` (another process) launches with them. */
function stagedSettingsFor(wardenHome: string, udid: string): StagedSettings {
	const path = launchSettingsPath(wardenHome, udid);
	return { read: () => readLaunchSettings(path), write: (next) => writeLaunchSettings(path, next) };
}

type NetworkFactory = NonNullable<Parameters<typeof createIosDriver>[2]["network"]>;

/** The per-app network layer for `o`, or `undefined` when the caller gave no lease proxy. */
function iosNetworkFactory(
	o: OpenIosDriverOptions,
	simctl: Simctl,
	now: () => number,
	sleep: (ms: number) => Promise<void>
): NetworkFactory | undefined {
	const proxy = o.networkProxy;
	if (!proxy) return undefined;
	const wardenHome = o.wardenHome ?? resolveWardenHome();
	return (ctx) =>
		createIosNetwork({
			proxy,
			channel: createInjectChannel({
				statePath: injectStatePath(wardenHome, o.udid),
				now,
				sleep,
				bundleId: ctx.lastBundle,
				...(o.injectFs ? { fs: o.injectFs } : {}),
			}),
			dylib: () =>
				locateInjectDylib({
					env: { [INJECT_DYLIB_ENV]: process.env[INJECT_DYLIB_ENV], WARDEN_HELPER_DIR: o.env?.helperDir },
					execPath: o.execPath ?? process.execPath,
					importDir: o.importDir ?? import.meta.dir,
					wardenHome,
					exists: o.exists ?? existsSync,
					realpath: o.realpath ?? realpathSync,
					...(o.version ? { version: o.version } : {}),
				}),
			isRunning: (bundleId) => simctl.isRunning(bundleId),
			lastBundle: ctx.lastBundle,
			relaunch: ctx.relaunch,
			...(o.debug ? { debug: true } : {}),
		});
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
