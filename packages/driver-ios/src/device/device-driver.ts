import { writeFile } from "node:fs/promises";
import type { AlertBackend, ProbesFrontmost, ReadsAlertOn } from "@delacour/warden-driver/alerts";
import type {
	Driver,
	DriverError,
	DriverResult,
	Element,
	Logger,
	Orientation,
	Point,
	Snapshot,
} from "@delacour/warden-driver/driver.types";
import { driverErrors } from "@delacour/warden-driver/errors";
import type { HealthData, OpData } from "@delacour/warden-driver/helper/simd-protocol";
import { physicalConditions } from "@delacour/warden-driver/physical-conditions";
import { spanDetails } from "@delacour/warden-driver/trace/span-detail";
import type { Exec } from "@delacour/warden-runtime/exec";
import type { Result } from "@delacour/warden-types/result";
import { IosEngineBase, okVoid, type Params } from "../ios-engine-base";
import { type RequestOptions, type SimdClient, simdClients } from "../simd-client";
import { typeBudget } from "../type-budget";
import { IOS_DEVICE_CAPABILITIES } from "./capabilities";
import { type Devicectl, DevicectlClient } from "./devicectl";
import { runnerProtocol } from "./runner-protocol";

/**
 * The `Driver` for a physical iPhone / iPad: input, accessibility and app lifecycle through `warden-runner` (the
 * XCUITest server `warden __ios-runner-host` keeps running on the phone, spoken to over the host's unix socket in the
 * `warden-simd` protocol, so the client, normalizer and alert reader are simd's), and `xcrun devicectl` for what the
 * runner cannot do: install / uninstall / probe, orientation changes, appearance and pasteboard reads, the screenshot
 * fallback. There is no select-all or paste (a field is cleared with counted Backspace), no native settle (snapshot
 * hashes), no multi-touch, and nothing that changes a phone beyond the app under test: an uninstall or data wipe of
 * a bundle warden did not install is `E_REFUSED`.
 */

export type IosDeviceEnv = { iosRunnerSocket: string; appPath: string; bundleId: string };

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
const LAUNCH_TIMEOUT_MS = 30_000;
const APP_OP_TIMEOUT_MS = 15_000;

/** Runner screenshot failures after which devicectl is worth a try (the op missing or failing, not a dead runner). */
const SCREENSHOT_FALLBACK: ReadonlySet<string> = new Set(["E_UNSUPPORTED", "E_IO", "E_INTERNAL"]);

export type IosDeviceEngineOptions = Omit<
	OpenIosDeviceDriverOptions,
	"client" | "exec" | "devicectl" | "env" | "socketPath"
> & {
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	write: (path: string, bytes: Uint8Array) => Promise<void>;
};

/** The `Driver` of one physical iPhone over its runner client and `devicectl`. Built by {@link IosDeviceDriverOpener}. */
export class IosDeviceEngine extends IosEngineBase implements IosDeviceDriver {
	readonly id: string;
	readonly capabilities = IOS_DEVICE_CAPABILITIES;

	override readonly network: IosDeviceDriver["network"];
	readonly networkFaults: IosDeviceDriver["networkFaults"];
	override readonly location: IosDeviceDriver["location"];
	override readonly clock: IosDeviceDriver["clock"];
	readonly permissions: IosDeviceDriver["permissions"];
	readonly timezone: IosDeviceDriver["timezone"];
	readonly locale: IosDeviceDriver["locale"];
	readonly a11y: IosDeviceDriver["a11y"];
	readonly battery: IosDeviceDriver["battery"];
	readonly memoryWarning: IosDeviceDriver["memoryWarning"];
	readonly push: IosDeviceDriver["push"];

	protected readonly client: SimdClient;
	protected readonly logTag = "[ios-device]";
	private readonly devicectl: Devicectl;
	private readonly opts: IosDeviceEngineOptions;
	/** bundles this session may uninstall: the app under test, earlier installs, and what this driver installed */
	private readonly owned: Set<string>;

	constructor(client: SimdClient, devicectl: Devicectl, opts: IosDeviceEngineOptions) {
		super({
			now: opts.now,
			sleep: opts.sleep,
			settleDefaults: { quietMs: DEFAULT_QUIET_MS, timeoutMs: DEFAULT_SETTLE_TIMEOUT_MS },
			...(opts.log ? { log: opts.log } : {}),
		});
		this.client = client;
		this.devicectl = devicectl;
		this.opts = opts;
		this.id = opts.udid;
		this.owned = new Set<string>([...(opts.ownedBundles ?? []), ...(opts.bundleId ? [opts.bundleId] : [])]);
		const ops = physicalConditions.ops(`physical iPhone ${opts.udid}`);
		this.network = ops.network;
		this.networkFaults = ops.networkFaults;
		this.location = ops.location;
		this.clock = ops.clock;
		this.permissions = ops.permissions;
		this.timezone = ops.timezone;
		this.locale = ops.locale;
		this.a11y = ops.a11y;
		this.battery = ops.battery;
		this.memoryWarning = ops.memoryWarning;
		this.push = ops.push;
	}

	protected healthDetail(d: HealthData): Record<string, unknown> {
		return { axDefault: d.ax.default, ...(d.state ? { state: d.state } : {}) };
	}

	elementAtPoint: IosDeviceDriver["elementAtPoint"] = async (point) => {
		const snap = await this.snapshot();
		return snap.success ? { success: true, data: this.hitTest(snap.data, point) } : snap;
	};

	swipe: IosDeviceDriver["swipe"] = (from, to, o) =>
		this.sendVoid(
			"swipe",
			this.params({ from, to, durationMs: o?.durationMs }),
			this.gestureTimeout(o?.durationMs, 300)
		);

	pinch: IosDeviceDriver["pinch"] = async () => this.unsupported("pinch", "the XCUITest runner takes one finger");
	rotate: IosDeviceDriver["rotate"] = async () => this.unsupported("rotate", "the XCUITest runner takes one finger");
	gesture: IosDeviceDriver["gesture"] = async () =>
		this.unsupported("gesture", "the XCUITest runner takes taps, swipes and drags only");
	biometrics: IosDeviceDriver["biometrics"] = async () =>
		this.unsupported("biometrics", "Face ID / Touch ID cannot be simulated on a real sensor; use a simulator");

	typeText: IosDeviceDriver["typeText"] = (text) =>
		this.sendVoid("typeText", { text }, typeBudget.deviceTypeText(text));

	pressButton: IosDeviceDriver["pressButton"] = async (button) => {
		if (button === "back") return this.fail(driverErrors.make("E_UNSUPPORTED", "iOS has no hardware back button"));
		if (button === "shake") return this.unsupported("shake", "the XCUITest runner cannot shake the phone");
		return this.sendVoid("pressButton", { button });
	};

	screenshot: IosDeviceDriver["screenshot"] = async (o) => {
		const viaRunner = await this.request("screenshot", this.params({ scale: o?.scale }));
		if (viaRunner.success) {
			const { png } = viaRunner.data;
			if (png === undefined) {
				return this.fail(driverErrors.make("E_INTERNAL", "warden-runner screenshot returned no png"));
			}
			const bytes = new Uint8Array(Buffer.from(png, "base64"));
			if (o?.path === undefined) return { success: true, data: { png: bytes } };
			await this.opts.write(o.path, bytes);
			return { success: true, data: { path: o.path } };
		}
		if (!SCREENSHOT_FALLBACK.has(viaRunner.error.code)) return viaRunner;
		this.opts.log?.(`[ios-device] runner screenshot failed (${viaRunner.error.code}), using devicectl`);
		return this.devicectl.screenshot(o?.path);
	};

	orientation: IosDeviceDriver["orientation"] = async (set) => {
		if (set !== undefined) {
			const changed = await this.devicectl.setOrientation(set);
			if (!changed.success) return changed;
		}
		return this.readOrientation();
	};

	alert: IosDeviceDriver["alert"] = async () => {
		const result = await this.request("alertButtons");
		if (!result.success) return result;
		return { success: true, data: result.data === null ? null : this.toAlertInfo(result.data) };
	};

	alertOn: IosDeviceDriver["alertOn"] = (_backend: AlertBackend) => this.alert();

	appearance: IosDeviceDriver["appearance"] = async (set) => {
		if (set !== undefined) {
			return this.fail(
				driverErrors.make(
					"E_REFUSED",
					`physical_protected: changing the appearance is a persistent settings write on physical device ${this.id}`,
					{ retryable: false, detail: { reason: "physical_protected" } }
				)
			);
		}
		return this.devicectl.appearance();
	};

	clipboard: IosDeviceDriver["clipboard"] = async (set) => {
		if (set === undefined) return this.devicectl.pasteboardPaste();
		const copied = await this.devicectl.pasteboardCopy(set);
		if (!copied.success) return copied;
		const back = await this.devicectl.pasteboardPaste();
		if (!back.success) return back;
		if (back.data !== set) {
			return this.fail(
				driverErrors.make("E_IO", "devicectl pasteboard copy exited 0 but the pasteboard does not hold the text")
			);
		}
		return { success: true, data: set };
	};

	readonly app: IosDeviceDriver["app"] = {
		launch: (bundleId, o) =>
			this.sendVoid(
				"launch",
				this.params({
					bundleId,
					args: o?.args && [...o.args],
					env: o?.env,
					terminateRunning: o?.relaunch !== false,
				}),
				LAUNCH_TIMEOUT_MS
			),
		terminate: (bundleId) => this.sendVoid("terminate", { bundleId }, APP_OP_TIMEOUT_MS),
		openUrl: (url) => this.sendVoid("openUrl", { url }, APP_OP_TIMEOUT_MS),
		install: (path) => this.install(path),
		uninstall: (bundleId) => this.uninstall(bundleId),
		isInstalled: (bundleId) => this.devicectl.isInstalled(bundleId),
		isRunning: async (bundleId) => {
			const result = await this.request("appState", { bundleId });
			if (!result.success) return result;
			const state = runnerProtocol.parseAppState(result.data);
			if (state === undefined)
				return this.fail(driverErrors.make("E_INTERNAL", "warden-runner appState returned no state"));
			return { success: true, data: runnerProtocol.isRunning(state) };
		},
		clearData: (bundleId) => this.clearData(bundleId),
	};

	private unsupported(what: string, why: string) {
		return this.fail(driverErrors.make("E_UNSUPPORTED", `${what} is not available on a physical iPhone: ${why}`));
	}

	/** The last element (deepest, topmost in preorder) whose frame holds `point`, ignoring hidden ones. */
	private hitTest(snapshot: Snapshot, point: Point): Element | null {
		let hit: Element | null = null;
		for (const element of snapshot.flat) {
			if (element.hidden === true) continue;
			const { x, y, width, height } = element.frame;
			if (point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height) hit = element;
		}
		return hit;
	}

	protected async request<Op extends string>(op: Op, p: Params = {}, o: RequestOptions = {}): DriverResult<OpData<Op>> {
		return this.client.request(op, p, o);
	}

	private async readOrientation(): DriverResult<Orientation> {
		const result = await this.request("orientation");
		if (!result.success) return result;
		return { success: true, data: this.interfaceOrientation(result.data.orientation) };
	}

	/** The refusal for a bundle warden did not install; a phone is somebody's, only warden's own installs are touched. */
	private guard(bundleId: string, action: "uninstall" | "clear the data of"): DriverError | undefined {
		if (this.owned.has(bundleId)) return undefined;
		return driverErrors.make(
			"E_REFUSED",
			`physical_protected: ${bundleId} was not installed by warden; refusing to ${action} it on physical device ${this.id}`,
			{ retryable: false, detail: { reason: "physical_protected", bundleId } }
		);
	}

	private async install(path: string): DriverResult<void> {
		const installed = await this.devicectl.install(path);
		if (!installed.success) return installed;
		for (const bundleId of installed.data.bundleIds) this.owned.add(bundleId);
		return okVoid;
	}

	private async uninstall(bundleId: string): DriverResult<void> {
		const refused = this.guard(bundleId, "uninstall");
		return refused ? this.fail(refused) : this.devicectl.uninstall(bundleId);
	}

	/** uninstall + reinstall from `WARDEN_APP_PATH`: the keychain survives an uninstall on iOS, so only the sandbox is wiped */
	private async clearData(bundleId: string): DriverResult<void> {
		const refused = this.guard(bundleId, "clear the data of");
		if (refused) return this.fail(refused);
		if (this.opts.appPath === undefined) {
			return this.fail(
				driverErrors.make(
					"E_BAD_REQUEST",
					"clearData reinstalls the app and needs WARDEN_APP_PATH (the build to put back)"
				)
			);
		}
		const removed = await this.devicectl.uninstall(bundleId);
		if (!removed.success) return removed;
		spanDetails.note("keychainKept", true);
		this.opts.log?.(`[ios-device] clearData(${bundleId}): reinstalled; the keychain items of the app were kept`);
		return this.install(this.opts.appPath);
	}
}

/** Opens {@link IosDeviceEngine}s. Use the shared {@link iosDeviceDriverOpener} singleton. */
export class IosDeviceDriverOpener {
	/**
	 * Open the driver for the phone `udid` against its runner host's socket (`socketPath` / `env.iosRunnerSocket` /
	 * `client`). `E_HELPER_MISSING` without any: the host is started by `warden ui` / `warden e2e`, never by the driver.
	 */
	async open(o: OpenIosDeviceDriverOptions): DriverResult<Driver> {
		const log: Logger = o.log ?? (() => undefined);
		const client = await this.runnerClient(o, log);
		if (!client.success) return client;
		const bundleId = o.bundleId ?? o.env?.bundleId;
		const appPath = o.appPath ?? o.env?.appPath;
		const devicectl = o.devicectl ?? new DevicectlClient({ udid: o.udid, exec: o.exec });
		return {
			success: true,
			data: new IosDeviceEngine(client.data, devicectl, {
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

	/** The runner host's client: the given one, else a connection to its socket; `E_HELPER_MISSING` with neither. */
	private async runnerClient(o: OpenIosDeviceDriverOptions, log: Logger): Promise<Result<SimdClient, DriverError>> {
		if (o.client) return { success: true, data: o.client };
		const socketPath = o.socketPath ?? o.env?.iosRunnerSocket;
		if (!socketPath) {
			return {
				success: false,
				error: driverErrors.make(
					"E_HELPER_MISSING",
					`no iOS runner for ${o.udid}: WARDEN_IOS_RUNNER_SOCKET is not set (warden starts the runner host with \`warden ui\` / \`warden e2e\`)`
				),
			};
		}
		return simdClients.connect({
			socketPath,
			log,
			...(o.defaultTimeoutMs ? { defaultTimeoutMs: o.defaultTimeoutMs } : {}),
		});
	}
}

export const iosDeviceDriverOpener = new IosDeviceDriverOpener();
