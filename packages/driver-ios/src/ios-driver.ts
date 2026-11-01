import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { launchSettingsFile } from "@delacour/warden-core/conditions/launch-settings";
import type { AlertBackend, ProbesFrontmost, ReadsAlertOn } from "@delacour/warden-driver/alerts";
import type { ClockRecorder } from "@delacour/warden-driver/clock-recorder";
import type {
	AlertInfo,
	Driver,
	DriverCapabilities,
	DriverError,
	DriverResult,
	HardwareButton,
	LaunchOptions,
	Logger,
} from "@delacour/warden-driver/driver.types";
import { driverErrors } from "@delacour/warden-driver/errors";
import { DEFAULT_RADIUS, type GesturePlan, gestureGeometry } from "@delacour/warden-driver/gesture-geometry";
import type { HealthData, OpData, RebindData, SettleData } from "@delacour/warden-driver/helper/simd-protocol";
import type { SimdSpawn } from "@delacour/warden-driver/helper/simd-transport";
import type { NetworkProxyPort } from "@delacour/warden-driver/network-proxy";
import type { SettleDetail } from "@delacour/warden-driver/settle";
import { spanDetails } from "@delacour/warden-driver/trace/span-detail";
import type { PastesText, SelectsAll } from "@delacour/warden-driver/typing";
import type { Exec } from "@delacour/warden-runtime/exec";
import { storeLocator } from "@delacour/warden-store/store";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { FileInjectChannel, INJECT_DYLIB_ENV, type InjectFs, injectProtocol } from "./inject";
import { IosEngineBase, okVoid, type Params } from "./ios-engine-base";
import { type IosNetwork, IosNetworkController } from "./ios-network";
import { type SwapPort, SwappableClient } from "./ios-session";
import { type IosSettings, IosSettingsController, iosLaunchSettings, type StagedSettings } from "./ios-settings";
import { helperLocator } from "./locate-helper";
import { elementNormalizer } from "./normalize";
import { type Simctl, SimctlRunner } from "./simctl";
import { type RequestOptions, type SimdClient, simdClients } from "./simd-client";
import { typeBudget } from "./type-budget";

/**
 * The iOS `Driver`: input, AX and app launch / terminate / openUrl through `warden-simd` (socket when
 * `WARDEN_SIMD_SOCKET` is set, else a helper spawned on stdio); install / uninstall / isRunning / clearData,
 * clipboard and appearance through `xcrun simctl`. Fallbacks: `typeText` pastes what the HID keyboard map
 * cannot type, `settle` polls snapshot hashes when the helper has no native quiescence, `screenshot` uses
 * `simctl io` when the helper cannot, and a helper built before the app ops leaves app lifecycle to `simctl`.
 */

/** What `warden e2e` puts in `WARDEN_SIMD` / `WARDEN_SIMD_SOCKET` / `WARDEN_HELPER_DIR`, read by the edge and passed in. */
export type IosDriverEnv = { simd?: string; simdSocket?: string; helperDir?: string };

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
	/** for `locateHelper` / `$WARDEN_HOME/simd/<version>`; `wardenHome` absent = no staged-copy lookup */
	version?: string;
	wardenHome?: string;
	execPath?: string;
	importDir?: string;
	exists?: (path: string) => boolean;
	realpath?: (path: string) => string;
	/** `@delacour/warden-<target>` lookup for the last `locateHelper` rung (default: `process.platform-arch`, `Bun.resolveSync` from `importDir`) */
	platformTarget?: string;
	resolvePackage?: (specifier: string) => string | undefined;
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
/** The helper's `launch` waits for the app to start, bounded like `simctl launch` was. */
const LAUNCH_TIMEOUT_MS = 30_000;
/** `terminate` / `openUrl` through the helper. */
const APP_OP_TIMEOUT_MS = 15_000;

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

type AppOp = "launch" | "terminate" | "openUrl";

/** Wire-level helpers of the iOS driver: request params, reply details, spans. Use the shared `iosWire` singleton. */
class IosWire {
	/** Drops `undefined` so optional driver options are absent on the wire rather than `null`. */
	params(values: Record<string, unknown>): Params {
		return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
	}

	/** The helper's whole settle verdict, for the caller and for the span timing the call; absent fields stay absent. */
	nativeDetail(data: SettleData): SettleDetail {
		const { quiet, waitedMs, via, reason, frontmostPid } = data;
		const detail: SettleDetail = {
			quiet,
			waitedMs,
			...(via === undefined ? {} : { via }),
			...(reason === undefined ? {} : { reason }),
			...(frontmostPid === undefined ? {} : { frontmostPid }),
		};
		if (via !== undefined) spanDetails.note("via", via);
		if (reason !== undefined) spanDetails.note("reason", reason);
		if (frontmostPid !== undefined) spanDetails.note("frontmostPid", frontmostPid);
		return detail;
	}

	/** Leaves the helper's rebind verdict on the current span. */
	noteRebind(data: RebindData): void {
		spanDetails.note("rebind", data.bound ? "bound" : (data.reason ?? "unbound"));
		spanDetails.note("rebindMs", data.waitedMs);
		if (data.restarts !== undefined && data.restarts > 0) spanDetails.note("rebindRestarts", data.restarts);
		if (data.recycled === true) spanDetails.note("rebindRecycled", true);
	}

	/** The `detail` of a `health` reply: only the helper fields that are present. */
	healthDetail(d: HealthData): Record<string, unknown> {
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

	restOf(error: DriverError, text: string): string | undefined {
		const detail = error.detail;
		if (typeof detail === "object" && detail !== null && "rest" in detail && typeof detail.rest === "string") {
			return detail.rest;
		}
		return text.length === 0 ? "" : undefined;
	}

	decodeBase64(png: string): Uint8Array {
		return new Uint8Array(Buffer.from(png, "base64"));
	}

	/** A helper built before an op answers `E_UNSUPPORTED`, or the dispatcher's `E_BAD_REQUEST unknown op`. */
	predatesOp(error: DriverError): boolean {
		return (
			error.code === "E_UNSUPPORTED" || (error.code === "E_BAD_REQUEST" && /unknown (input )?op/.test(error.message))
		);
	}
}

const iosWire = new IosWire();

export type IosDriverEngineOptions = {
	udid: string;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	log?: Logger;
	/** told about every successful `clock` op */
	clockRecorder?: ClockRecorder;
	/** device settings (`ios-settings.ts`); absent: those ops answer `E_UNSUPPORTED` */
	settings?: (ctx: { lastBundle: () => string | undefined }) => IosSettings;
	/** per-app network conditions (`ios-network.ts`); absent: `network` answers `E_UNSUPPORTED` */
	network?: IosNetworkFactory;
};

export type IosNetworkFactory = (deps: {
	lastBundle: () => string | undefined;
	relaunch: (bundleId: string) => DriverResult<void>;
}) => IosNetwork;

/** The iOS `Driver` over one helper client (`SwapPort`) and `simctl`. Built by {@link IosDriverOpener}. */
export class IosDriverEngine extends IosEngineBase implements IosDriver {
	readonly id: string;
	readonly capabilities: DriverCapabilities;

	private readonly swap: SwapPort;
	private readonly simctl: Simctl;
	private readonly opts: IosDriverEngineOptions;
	protected readonly client: SwapPort["client"];
	protected readonly logTag = "[ios]";
	private readonly settings: IosSettings | undefined;
	private readonly net: IosNetwork | undefined;
	private readonly axSettle: boolean;
	private readonly bridgeUp: boolean;

	private lastLaunched: string | undefined;
	private axFailures = 0;
	/**
	 * The bundle `app.launch` started and no settle has confirmed yet. Right after `simctl launch` the previous
	 * frontmost app (SpringBoard) is still the one the helper sees and it is already quiet, so the next native
	 * settle names this bundle and the helper waits until it is frontmost.
	 */
	private launchedBundle: string | undefined;
	private settleUnsupported: boolean;
	private rebindUnsupported = false;
	private gestureUnsupported = false;
	/** set once the helper did not know an app lifecycle op: it predates them, and `simctl` does app lifecycle */
	private appOpsOutdated = false;
	/**
	 * Set once a lost helper could not be replaced: every later call answers it at once, not retryable, rather
	 * than paying a connect and a spawn each time or having each look poll a dead client until its timeout.
	 */
	private lost: DriverError | undefined;
	/** the generation of the helper that last answered; one reconnect per helper that answered, so a crash loop stops */
	private answeredGeneration: number;

	constructor(swap: SwapPort, simctl: Simctl, opts: IosDriverEngineOptions) {
		super({
			now: opts.now,
			sleep: opts.sleep,
			settleDefaults: { quietMs: DEFAULT_QUIET_MS, timeoutMs: DEFAULT_SETTLE_TIMEOUT_MS },
			...(opts.log ? { log: opts.log } : {}),
			...(opts.clockRecorder ? { clockRecorder: opts.clockRecorder } : {}),
		});
		this.swap = swap;
		this.simctl = simctl;
		this.opts = opts;
		this.id = opts.udid;
		this.client = swap.client;
		this.settings = opts.settings?.({ lastBundle: () => this.lastLaunched });
		// late-bound: the network helper relaunches through the driver's own `app.launch`
		this.net = opts.network?.({
			lastBundle: () => this.lastLaunched,
			relaunch: (bundleId) => this.app.launch(bundleId, { relaunch: true, inject: true }),
		});
		const { ready } = this.client;
		this.axSettle = ready.ax.default === "axbridge" && ready.ax.bridge === "available";
		this.bridgeUp = ready.ax.bridge === "available";
		this.settleUnsupported = !this.axSettle;
		this.answeredGeneration = swap.generation();
		this.capabilities = {
			pinch: true,
			maxPointers: 2,
			unicodeText: true,
			nativeSettle: this.axSettle,
			alerts: true,
			reachability: true,
			cheapHitTest: true,
		};
	}

	protected healthDetail(d: HealthData): Record<string, unknown> {
		return iosWire.healthDetail(d);
	}

	/**
	 * The first `E_AX_UNAVAILABLE` goes to the caller (it is retryable); a second one in a row means the
	 * in-sim AX bridge went stale, so restart the helper once and retry the snapshot.
	 */
	override readonly snapshot: IosDriver["snapshot"] = async (o) => {
		const generation = this.swap.generation();
		const first = await this.fetchSnapshot(o);
		if (first.success) {
			this.axFailures = 0;
			return first;
		}
		if (first.error.code !== "E_AX_UNAVAILABLE") {
			this.axFailures = 0;
			return first;
		}
		this.axFailures += 1;
		if (this.axFailures < 2) return first;
		this.opts.log?.("[ios] E_AX_UNAVAILABLE twice in a row: AX bridge looks stale, restarting warden-simd");
		const restarted = await this.swap.restart(generation);
		if (!restarted.success) return restarted;
		this.axFailures = 0;
		return this.fetchSnapshot(o);
	};

	elementAtPoint: IosDriver["elementAtPoint"] = async (point, o) => {
		const result = await this.request(
			"elementAtPoint",
			iosWire.params({ x: point.x, y: point.y, reachability: o?.reachability })
		);
		if (!result.success) return result;
		return {
			success: true,
			data: result.data === null ? null : elementNormalizer.element(result.data, this.client.ready.screen),
		};
	};

	swipe: IosDriver["swipe"] = (from, to, o) =>
		this.sendVoid(
			"swipe",
			iosWire.params({ from, to, durationMs: o?.durationMs, momentum: o?.momentum }),
			this.gestureTimeout(o?.durationMs, 300)
		);

	pinch: IosDriver["pinch"] = (center, scale, o) =>
		this.sendVoid(
			"pinch",
			iosWire.params({ center, scale, durationMs: o?.durationMs, radius: o?.radius, angle: o?.angle }),
			this.gestureTimeout(o?.durationMs, 300)
		);

	rotate: IosDriver["rotate"] = (center, degrees, o) =>
		this.sendGesture(gestureGeometry.rotatePlan(center, degrees, o, DEFAULT_RADIUS));

	gesture: IosDriver["gesture"] = (paths, o) => this.sendGesture(gestureGeometry.planGesture(paths, o, 2));

	typeText: IosDriver["typeText"] = async (text) => {
		const typed = await this.sendVoid("typeText", { text }, typeBudget.typeText(text));
		if (typed.success || typed.error.code !== "E_UNSUPPORTED_TEXT") return typed;
		const rest = iosWire.restOf(typed.error, text);
		if (rest === undefined) return typed;
		this.opts.log?.(`[ios] typeText: pasting ${rest.length} unmappable character(s)`);
		return this.pasteText(rest);
	};

	selectAll: IosDriver["selectAll"] = () => this.sendVoid("selectAll");

	/**
	 * Puts `text` on the simulator pasteboard (confirmed by `pbpaste`) and sends one Cmd+V; a pasteboard write that
	 * cannot be confirmed pastes nothing. A failure is logged (code and message, never the text), because `fill`
	 * types the text instead and the only other trace of it would be a fill that took per-character time.
	 */
	pasteText: IosDriver["pasteText"] = async (text) => {
		if (text === "") return resultFactory.ok(undefined);
		const copied = await this.simctl.pbcopy(text);
		const result = copied.success ? await this.sendVoid("paste") : copied;
		if (!result.success) this.opts.log?.(`[ios] pasteText failed (${result.error.code}): ${result.error.message}`);
		return result;
	};

	pressButton: IosDriver["pressButton"] = async (button) => {
		if (button === "back") return this.fail(driverErrors.make("E_UNSUPPORTED", "iOS has no hardware back button"));
		return this.sendVoid("pressButton", { button: BUTTONS[button] });
	};

	screenshot: IosDriver["screenshot"] = async (o) => {
		const viaHelper = await this.request("screenshot", iosWire.params({ path: o?.path, scale: o?.scale }));
		if (viaHelper.success) {
			const { path, png } = viaHelper.data;
			if (o?.path) return { success: true, data: { path: path ?? o.path } };
			if (png !== undefined) return { success: true, data: { png: iosWire.decodeBase64(png) } };
			if (path !== undefined) return { success: true, data: { path } };
			return this.fail(driverErrors.make("E_INTERNAL", "warden-simd screenshot returned neither path nor png"));
		}
		if (!SCREENSHOT_FALLBACK.has(viaHelper.error.code)) return viaHelper;
		this.opts.log?.(`[ios] helper screenshot failed (${viaHelper.error.code}), using simctl io`);
		return this.simctl.screenshot(o?.path);
	};

	orientation: IosDriver["orientation"] = async (set) => {
		const result = await this.request("orientation", iosWire.params({ set }));
		if (!result.success) return result;
		const { orientation: read, source } = result.data;
		if (source !== undefined && source !== "device")
			this.opts.log?.(`[ios] orientation ${read} is ${source}, not read from the device`);
		const upright = this.interfaceOrientation(read);
		if (upright !== read) this.opts.log?.(`[ios] device reports ${read}; exposing it as portrait`);
		return { success: true, data: upright };
	};

	alert: IosDriver["alert"] = () => this.readAlert();

	/** Without the bridge `axbridge` has nothing to read: the host reader is the one reader left. */
	alertOn: IosDriver["alertOn"] = (backend) =>
		this.readAlert(backend === "axbridge" && !this.bridgeUp ? "ax" : backend);

	protected override frontmostGuard(): DriverError | undefined {
		return this.bridgeUp ? undefined : driverErrors.make("E_UNSUPPORTED", "frontmost needs the axbridge backend");
	}

	appearance: IosDriver["appearance"] = (set) => this.simctl.appearance(set);
	override readonly network: IosDriver["network"] = async (op, o) =>
		this.net ? this.net.network(op, o) : this.noLeaseProxy();
	networkFaults: IosDriver["networkFaults"] = async (faults) =>
		this.net ? this.net.networkFaults(faults) : this.noLeaseProxy();
	override readonly location: IosDriver["location"] = (op) => this.simctl.location(op);
	permissions: IosDriver["permissions"] = (grants, o) =>
		this.settings ? this.settings.permissions(grants, o) : this.noSettings();
	timezone: IosDriver["timezone"] = (tz, o) => (this.settings ? this.settings.timezone(tz, o) : this.noSettings());
	locale: IosDriver["locale"] = (tag, o) => (this.settings ? this.settings.locale(tag, o) : this.noSettings());
	a11y: IosDriver["a11y"] = (op) => (this.settings ? this.settings.a11y(op) : this.noSettings());
	battery: IosDriver["battery"] = (op) => (this.settings ? this.settings.battery(op) : this.noSettings());
	memoryWarning: IosDriver["memoryWarning"] = (o) =>
		this.settings ? this.settings.memoryWarning(o) : this.noSettings();
	push: IosDriver["push"] = (payload, o) => (this.settings ? this.settings.push(payload, o) : this.noSettings());

	protected override async applyClock(op: Parameters<IosDriver["clock"]>[0], o?: Parameters<IosDriver["clock"]>[1]) {
		return this.net ? this.net.clock(op, o) : this.noLeaseProxy();
	}

	biometrics: IosDriver["biometrics"] = (op) => this.simctl.biometrics(op);

	clipboard: IosDriver["clipboard"] = async (set) => {
		if (set === undefined) return this.simctl.pbpaste();
		const copied = await this.simctl.pbcopy(set);
		return copied.success ? { success: true, data: set } : copied;
	};

	readonly app: IosDriver["app"] = {
		launch: async (bundleId, plain) => {
			const requested = this.settings ? iosLaunchSettings.withStaged(plain, this.settings.launchSettings()) : plain;
			const withEnv = await this.launchWithInjection(requested);
			if (!withEnv.success) return withEnv;
			const o = withEnv.data;
			const viaHelper = await this.appOp(
				"launch",
				iosWire.params({
					bundleId,
					args: o?.args && [...o.args],
					env: o?.env,
					terminateRunning: o?.relaunch !== false,
				}),
				LAUNCH_TIMEOUT_MS
			);
			const launched = await this.appOutcome(
				viaHelper,
				() => this.simctl.launch(bundleId, o),
				(data) => spanDetails.note("pid", data.pid)
			);
			if (launched.success) {
				this.lastLaunched = bundleId;
				this.launchedBundle = bundleId;
				if (await this.rebind(bundleId)) this.launchedBundle = undefined;
				const loaded = await this.net?.confirmLoaded();
				if (loaded && !loaded.success) return loaded;
			}
			return launched;
		},
		terminate: async (bundleId) => {
			const viaHelper = await this.appOp("terminate", { bundleId }, APP_OP_TIMEOUT_MS);
			const terminated = await this.appOutcome(
				viaHelper,
				() => this.simctl.terminate(bundleId),
				(data) => spanDetails.note("terminated", data.terminated)
			);
			if (terminated.success && this.launchedBundle === bundleId) this.launchedBundle = undefined;
			return terminated;
		},
		openUrl: async (url) => {
			const viaHelper = await this.appOp("openUrl", { url }, APP_OP_TIMEOUT_MS);
			return this.appOutcome(
				viaHelper,
				() => this.simctl.openUrl(url),
				() => undefined
			);
		},
		install: (path) => this.simctl.install(path),
		uninstall: (bundleId) => this.simctl.uninstall(bundleId),
		isInstalled: (bundleId) => this.simctl.isInstalled(bundleId),
		isRunning: (bundleId) => this.simctl.isRunning(bundleId),
		clearData: (bundleId, o) => this.simctl.clearData(bundleId, o),
	};

	private async noLeaseProxy() {
		return driverErrors.err(
			"E_UNSUPPORTED",
			"network and clock conditions on iOS need a device lease for the shaping proxy: run the spec with `warden e2e` (it sets WARDEN_LEASE_ID), or `warden ui`; a bare `bun test` has no lease"
		);
	}

	private async noSettings() {
		return driverErrors.err("E_UNSUPPORTED", "this iOS driver was opened without device settings support");
	}

	/** `requested` with the injected dylib's env merged in, when the lease has a network or clock condition. */
	private async launchWithInjection(
		requested: LaunchOptions | undefined
	): Promise<Result<LaunchOptions | undefined, DriverError>> {
		const injected = this.net ? await this.net.launchEnv(requested ?? {}) : undefined;
		if (injected && !injected.success) return injected;
		const env = injected?.data;
		return { success: true, data: env ? { ...requested, env: { ...requested?.env, ...env } } : requested };
	}

	/**
	 * Replace the helper that went away under generation `seen`, once. Undefined: go on (replaced now, or by a
	 * concurrent caller); else the error to return (a helper that never answered since its replacement is not
	 * replaced again, so a crash loop stops).
	 */
	private async replaceLost(op: string, seen: number, crash: DriverError): Promise<DriverError | undefined> {
		if (seen !== this.swap.generation()) return undefined;
		if (seen !== this.answeredGeneration) return crash;
		this.opts.log?.(`[ios] warden-simd went away during \`${op}\` (E_HELPER_CRASHED: ${crash.message}); reconnecting`);
		const restarted = await this.swap.restart(seen, { crashed: true });
		if (restarted.success) return undefined;
		const why = `${restarted.error.code}: ${restarted.error.message}`;
		this.opts.log?.(`[ios] could not replace warden-simd (${why})`);
		this.lost ??= driverErrors.make("E_HELPER_CRASHED", `${crash.message}; could not replace it (${why})`, {
			retryable: false,
		});
		return this.lost;
	}

	/**
	 * Every helper request. `E_HELPER_CRASHED` (the helper exited or the socket daemon's connection closed) is
	 * answered like a stale bridge: the helper is replaced once (`swap.restart`, socket first, else a stdio
	 * spawn) and a read is asked again; an input op's error is returned unchanged, the next call uses the new helper.
	 */
	protected async request<Op extends string>(op: Op, p: Params = {}, o: RequestOptions = {}): DriverResult<OpData<Op>> {
		if (this.lost) return this.fail(this.lost);
		const seen = this.swap.generation();
		const first = await this.client.request(op, p, o);
		if (first.success) {
			this.answeredGeneration = seen;
			return first;
		}
		if (first.error.code !== "E_HELPER_CRASHED") return first;
		const stop = await this.replaceLost(op, seen, first.error);
		if (stop) return this.fail(stop);
		if (!RETRIED_AFTER_CRASH.has(op)) return first;
		const generation = this.swap.generation();
		const again = await this.client.request(op, p, o);
		if (again.success) this.answeredGeneration = generation;
		return again;
	}

	private helperOutdated() {
		return this.fail(
			driverErrors.make(
				"E_UNSUPPORTED",
				`this warden-simd predates the gesture op: restart the helper (warden ui close --udid ${this.id}) or rebuild it (bun run --cwd packages/driver-ios native:build)`,
				{ detail: { reason: "helper_outdated" } }
			)
		);
	}

	/** Replays a plan through the helper's `gesture` op; an old helper that doesn't know the op is remembered. */
	private async sendGesture(planned: Result<GesturePlan, DriverError>): DriverResult<void> {
		if (!planned.success) return planned;
		if (this.gestureUnsupported) return this.helperOutdated();
		const plan = planned.data;
		const result = await this.sendVoid(
			"gesture",
			{ paths: plan.paths, frameMs: plan.frameMs, holdMs: plan.holdMs, releaseMs: plan.releaseMs },
			this.gestureTimeout(plan.totalMs, 300)
		);
		if (!result.success && result.error.code === "E_BAD_REQUEST" && /unknown (input )?op/.test(result.error.message)) {
			this.gestureUnsupported = true;
			return this.helperOutdated();
		}
		return result;
	}

	/**
	 * `launch` / `terminate` / `openUrl` through the helper, whose process already holds CoreSimulator: every `xcrun
	 * simctl` start loads it again (~0.13 CPU-s on the host, one per `app.open`). `undefined` means this helper predates
	 * the ops: remembered after the first such answer (logged once), and the caller runs the `simctl` equivalent. Any
	 * other failure is the answer, like a failed `simctl` was.
	 */
	private async appOp<Op extends AppOp>(
		op: Op,
		p: Params,
		timeoutMs: number
	): Promise<Result<OpData<Op>, DriverError> | undefined> {
		if (this.appOpsOutdated) {
			spanDetails.note("via", "simctl");
			return undefined;
		}
		const result = await this.request(op, p, { timeoutMs });
		if (!result.success && iosWire.predatesOp(result.error)) {
			this.appOpsOutdated = true;
			spanDetails.note("via", "simctl");
			spanDetails.note("reason", "helper_outdated");
			this.opts.log?.(
				`[ios] this warden-simd predates the \`${op}\` op (${result.error.code}: ${result.error.message}); app lifecycle goes through simctl until the helper is restarted (warden ui close --udid ${this.id}) or rebuilt (bun run --cwd packages/driver-ios native:build)`
			);
			return undefined;
		}
		spanDetails.note("via", "simd");
		return result;
	}

	/** The outcome of an app op: `fallback` when this helper predates it, else the helper's answer with `note` on its data. */
	private async appOutcome<Data>(
		viaHelper: Result<Data, DriverError> | undefined,
		fallback: () => DriverResult<void>,
		note: (data: Data) => void
	): DriverResult<void> {
		if (viaHelper === undefined) return fallback();
		if (!viaHelper.success) return viaHelper;
		note(viaHelper.data);
		return okVoid;
	}

	/**
	 * Right after `simctl launch` the helper's quiescence stream still reports on the previous frontmost app; the first
	 * AX read then fails with `did not respond` and the repair costs seconds. `rebind` makes the helper wait (briefly,
	 * and without restarting a stream that follows by itself) until the stream reports on the new process, so the
	 * first read and settle after a launch are fast. Best effort: any failure leaves the launch as it was.
	 */
	private async rebind(bundleId: string): Promise<boolean> {
		if (this.rebindUnsupported || this.settleUnsupported) return false;
		const reply = await this.request(
			"rebind",
			{ bundleId, rebindTimeoutMs: REBIND_TIMEOUT_MS },
			{ timeoutMs: REBIND_TIMEOUT_MS + SETTLE_MARGIN_MS }
		);
		if (!reply.success) {
			if (reply.error.code === "E_UNSUPPORTED" || reply.error.code === "E_BAD_REQUEST") this.rebindUnsupported = true;
			spanDetails.note("rebind", reply.error.code);
			this.opts.log?.(`[ios] rebind after launch failed (${reply.error.code}): ${reply.error.message}`);
			return false;
		}
		iosWire.noteRebind(reply.data);
		return reply.data.bound;
	}

	/**
	 * The helper's own settle, or undefined when it is unsupported (the caller falls back to polling snapshot hashes).
	 * The helper's budget is `settleTimeoutMs`; the envelope `timeoutMs` is only our padded transport timer.
	 */
	private async settleViaHelper(quietMs: number, timeoutMs: number): Promise<DriverResult<SettleDetail> | undefined> {
		const expected = this.launchedBundle;
		const native = await this.request(
			"settle",
			{ quietMs, settleTimeoutMs: timeoutMs, ...(expected === undefined ? {} : { bundleId: expected }) },
			{ timeoutMs: timeoutMs + SETTLE_MARGIN_MS }
		);
		if (native.success) {
			// a mismatch means the app never came to the front: keep asking for it on the next settle
			if (expected !== undefined && native.data.reason !== "frontmost_mismatch") this.launchedBundle = undefined;
			return { success: true, data: iosWire.nativeDetail(native.data) };
		}
		// settle is best effort: a loaded machine answering after the padded timer means "not quiet", not a failure
		if (native.error.code === "E_TIMEOUT") {
			spanDetails.note("reason", "helper_timeout");
			return {
				success: true,
				data: { quiet: false, waitedMs: timeoutMs + SETTLE_MARGIN_MS, reason: "helper_timeout" },
			};
		}
		if (native.error.code !== "E_UNSUPPORTED") return native;
		this.settleUnsupported = true;
		this.opts.log?.("[ios] native settle unsupported, polling snapshot hashes");
		return undefined;
	}

	protected override async nativeSettle(o: { quietMs: number; timeoutMs: number }) {
		return this.settleUnsupported ? undefined : this.settleViaHelper(o.quietMs, o.timeoutMs);
	}

	/** The helper's `alertButtons`: both readers without a `backend`, only that one with it. */
	private async readAlert(backend?: AlertBackend): DriverResult<AlertInfo | null> {
		const result = await this.request("alertButtons", iosWire.params({ backend }));
		if (!result.success) return result;
		return { success: true, data: result.data === null ? null : this.toAlertInfo(result.data) };
	}
}

/** Opens {@link IosDriverEngine}s: finds or spawns the helper, connects, wires settings and network. Use the shared {@link iosDriverOpener} singleton. */
export class IosDriverOpener {
	/**
	 * Open the iOS driver for `udid`. Writes `AutomationEnabled` (best effort) while the helper starts.
	 * `E_HELPER_MISSING` (with the `warden doctor` hint) when no helper binary can be found.
	 */
	async open(o: OpenIosDriverOptions): DriverResult<Driver> {
		const log: Logger = o.log ?? (() => undefined);
		const now = o.now ?? Date.now;
		const exec = o.debug ? this.timedExec(o.exec, log, now) : o.exec;
		const simctl = new SimctlRunner({
			udid: o.udid,
			exec,
			...(o.devicesRoot ? { devicesRoot: o.devicesRoot } : {}),
		});
		// a driver that cannot start (no socket, no helper binary) fails before any simctl call: the AutomationEnabled
		// write takes seconds on a cold machine and would only delay the E_HELPER_MISSING answer
		const unstartable = this.unstartable(o);
		if (unstartable) return unstartable;
		const connecting: Promise<Result<SimdClient, DriverError>> = o.client
			? Promise.resolve({ success: true, data: o.client })
			: this.connect(o, log);
		const [client, automation] = await Promise.all([connecting, simctl.enableAutomation()]);
		if (!automation.success) log(`[ios] could not enable AX automation: ${automation.error.message}`);
		if (!client.success) return client;
		const swap = new SwappableClient(client.data, {
			now,
			log,
			reopen: () => this.connect(o, log),
			...(o.debug ? { debug: true } : {}),
		});
		const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
		const network = this.networkFactory(o, simctl, now, sleep);
		return {
			success: true,
			data: new IosDriverEngine(swap, simctl, {
				udid: o.udid,
				now,
				sleep,
				log,
				...(network ? { network } : {}),
				settings: (ctx) =>
					new IosSettingsController({
						udid: o.udid,
						exec,
						lastBundle: ctx.lastBundle,
						...(o.bundleId ? { defaultBundle: o.bundleId } : {}),
						staged:
							o.stagedSettings ?? this.stagedSettingsFor(o.wardenHome ?? storeLocator.wardenHome(process.env), o.udid),
					}),
				...(o.clockRecorder ? { clockRecorder: o.clockRecorder } : {}),
			}),
		};
	}

	/** The `E_HELPER_MISSING` of a driver that has neither a client, a socket nor a helper binary to start; else undefined. */
	private unstartable(o: OpenIosDriverOptions): { success: false; error: DriverError } | undefined {
		if (o.client || (o.socketPath ?? o.env?.simdSocket)) return undefined;
		const helper = helperLocator.resolve(o);
		return helper.success ? undefined : helper;
	}

	private timeoutOption(o: OpenIosDriverOptions) {
		return o.defaultTimeoutMs ? { defaultTimeoutMs: o.defaultTimeoutMs } : {};
	}

	/**
	 * The pre-warmed daemon, when a socket is configured and answers; undefined means "spawn instead". A configured
	 * socket that does not answer is asked once more after {@link SOCKET_RETRY_MS} (a loaded host, a
	 * daemon still starting): a stdio helper next to a live daemon means two quiescence streams on one simulator,
	 * which slows every `settle` of both (20-1). A protocol mismatch is not retried.
	 */
	private async trySocket(o: OpenIosDriverOptions, log: Logger): Promise<SimdClient | undefined> {
		const socketPath = o.socketPath ?? o.env?.simdSocket;
		if (!socketPath) return undefined;
		const first = await simdClients.connect({ socketPath, log, ...this.timeoutOption(o) });
		if (first.success) return first.data;
		if (!first.error.retryable) {
			log(`[ios] WARNING: ${first.error.message}; spawning a helper on stdio instead`);
			return undefined;
		}
		log(`[ios] WARNING: ${first.error.message}; retrying once in ${SOCKET_RETRY_MS} ms`);
		await (o.sleep ?? ((ms: number) => Bun.sleep(ms)))(SOCKET_RETRY_MS);
		const second = await simdClients.connect({ socketPath, log, ...this.timeoutOption(o) });
		if (second.success) return second.data;
		log(
			`[ios] WARNING: ${second.error.message}; spawning a helper on stdio instead (a live daemon on ${socketPath} would now share the simulator with it)`
		);
		return undefined;
	}

	private async connect(o: OpenIosDriverOptions, log: Logger): Promise<Result<SimdClient, DriverError>> {
		const socket = await this.trySocket(o, log);
		if (socket) return { success: true, data: socket };
		const helper = helperLocator.resolve(o);
		if (!helper.success) return helper;
		const resources = join(dirname(helper.data), "Resources");
		return simdClients.spawn({
			helperPath: helper.data,
			udid: o.udid,
			log,
			...((o.exists ?? existsSync)(resources) ? { resources } : {}),
			...(o.spawn ? { spawn: o.spawn } : {}),
			...this.timeoutOption(o),
		});
	}

	/** Timezone / locale staged in a file per device, so a later `warden ui open` (another process) launches with them. */
	private stagedSettingsFor(wardenHome: string, udid: string): StagedSettings {
		const path = launchSettingsFile.path(wardenHome, udid);
		return { read: () => launchSettingsFile.read(path), write: (next) => launchSettingsFile.write(path, next) };
	}

	/** The per-app network layer for `o`, or `undefined` when the caller gave no lease proxy. */
	private networkFactory(
		o: OpenIosDriverOptions,
		simctl: Simctl,
		now: () => number,
		sleep: (ms: number) => Promise<void>
	): IosNetworkFactory | undefined {
		const proxy = o.networkProxy;
		if (!proxy) return undefined;
		const wardenHome = o.wardenHome ?? storeLocator.wardenHome(process.env);
		return (ctx) =>
			new IosNetworkController({
				proxy,
				channel: new FileInjectChannel({
					statePath: injectProtocol.statePath(wardenHome, o.udid),
					now,
					sleep,
					bundleId: ctx.lastBundle,
					...(o.injectFs ? { fs: o.injectFs } : {}),
				}),
				dylib: () =>
					injectProtocol.locateDylib({
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
	private timedExec(exec: Exec, log: Logger, now: () => number): Exec {
		return async (cmd, opts) => {
			const started = now();
			const res = await exec(cmd, opts);
			const label = cmd[0] === "sh" ? "sh (pbcopy)" : cmd.slice(0, 3).join(" ");
			log(`[ios] exec ${label} ${Math.round(now() - started)} ms (exit ${res.exitCode})`);
			return res;
		};
	}
}

export const iosDriverOpener = new IosDriverOpener();
