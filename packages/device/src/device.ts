import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	ACCEPT_BUTTONS,
	ANDROID_NEGATIVE_ID,
	ANDROID_PERMISSION_ALLOW_IDS,
	ANDROID_PERMISSION_DENY_IDS,
	ANDROID_POSITIVE_ID,
	alertButtons,
	DISMISS_BUTTONS,
} from "@delacour/warden-driver/alert-buttons";
import { alertCapabilities } from "@delacour/warden-driver/alerts";
import type { ConditionSink } from "@delacour/warden-driver/conditions/condition-events";
import type {
	AlertInfo,
	BiometricOp,
	BiometricState,
	Driver,
	Element,
	Orientation,
	Platform,
	Snapshot,
} from "@delacour/warden-driver/driver.types";
import { E2eError } from "@delacour/warden-driver/e2e-error";
import {
	DEFAULT_SETTLE_QUIET_MS,
	DEFAULT_SETTLE_TIMEOUT_MS,
	type SettleDetail,
	settler,
} from "@delacour/warden-driver/settle";
import type { TraceEvent } from "@delacour/warden-driver/trace/trace-event";
import { driverCalls } from "@delacour/warden-driver/unwrap";
import type { Locator } from "@delacour/warden-screen/locator";
import { snapshotRenderer } from "@delacour/warden-screen/render";
import { DeviceAlertReader } from "./alert-reader";
import { artifactPaths } from "./artifacts";
import {
	type ConditionRun,
	type ConditionsEnv,
	conditionRegistry,
	type DeviceClock,
	type DeviceConditions,
	DeviceConditionsImpl,
	type DeviceLocation,
	type DeviceNetwork,
	type DevicePermissions,
	type TimelineStepInput,
} from "./conditions/device-conditions";
import { type ConditionRecorder, leaseRecorderResolver } from "./conditions/lease-recorder";
import { type DeviceDevtools, DeviceDevtoolsFacade, type DevtoolsSource } from "./device-devtools";
import { deviceLinks, OPEN_LINK_WAIT_MS } from "./device-link";
import { type Clock, type FixtureSession, systemClock } from "./fixture-session";
import { perfBudgets } from "./perf/budgets";
import { type DevicePerf, DevicePerfImpl, type PerfExec, perfLauncher } from "./perf/device-perf";

export type AlertAction = "accept" | "dismiss" | { button: string };

export type OpenLinkOptions = {
	/** answer iOS's "Open in …?" sheet with "Open". Default true. */
	accept?: boolean;
	/**
	 * Return as soon as this locator is visible and no sheet is up, instead of when the link is known to be handled.
	 * Use it when the link leads to a screen the app is not already showing; the wait still ends at `waitMs`
	 * (without an error: the next assertion reports the missing screen).
	 */
	until?: Locator;
	/** The longest `openLink` waits, in ms. Default 8000. */
	waitMs?: number;
};

export type SnapshotTextOptions = { interactiveOnly?: boolean };

export type SettleOptions = {
	/** how long the UI must stay unchanged. Default 250 ms. */
	quietMs?: number;
	/** give up after this long. Default 3000 ms. */
	timeout?: number;
};

export type { BiometricState };

/**
 * Simulated Face ID / Touch ID / fingerprint (simulators and emulators only). Every method answers the state after the op.
 * iOS: the first prompt per app shows an "Allow X to use Face ID?" alert; answer it with `device.alert("accept")`.
 * Enroll before installing or launching the app: a new enrollment invalidates biometry-bound keys.
 * Android: `enroll` / `unenroll` throw `ACTION_FAILED` (driver `E_UNSUPPORTED`); enrollment comes from the golden snapshot, so set
 * the profile's `biometrics: true`.
 */
export type DeviceBiometrics = {
	status(): Promise<BiometricState>;
	/** iOS: enrolls Face ID / Touch ID. Android: unsupported, use profile `biometrics: true`. */
	enroll(): Promise<BiometricState>;
	/** iOS: removes the enrollment. Android: unsupported. */
	unenroll(): Promise<BiometricState>;
	/** Presents a matching face / finger to the pending prompt. */
	match(): Promise<BiometricState>;
	/** Presents a non-matching face / finger to the pending prompt. */
	fail(): Promise<BiometricState>;
};

export type Device = {
	/**
	 * Answers the system alert / sheet on top. `accept` presses the first present of OK, Allow, Open,
	 * Continue, Yes, Done, Allow While Using App, Allow Once (else the last button); `dismiss` the first
	 * of Cancel, Don't Allow, Not Now, Dismiss, No, Close (else the first button); `{button}` the button
	 * with that name (`ACTION_FAILED` when absent). The Android autofill "Save password?" sheet is closed with Back for
	 * `accept` and `dismiss` alike (never its Never / Continue buttons, which write to the user's account). Resolves false
	 * when no alert is showing.
	 */
	alert(action: AlertAction): Promise<boolean>;
	/**
	 * Opens a URL from outside the app. On iOS it accepts the "Open in …?" sheet when one shows (pressing again if it
	 * stays up) and returns once the link is handled: the sheet was answered, or none showed for 1.2 s while the app is
	 * in front (so a link without a sheet costs about 1.3 s, and later links with the same scheme in this session return
	 * as soon as the app is in front). While another app (SpringBoard, Safari) is in front it keeps looking for the sheet
	 * for up to `waitMs` (8 s). Pass `until` to return when the target screen is visible.
	 */
	openLink(url: string, options?: OpenLinkOptions): Promise<void>;
	home(): Promise<void>;
	/** Android back key; `INVALID_ARGUMENT` on iOS (there is none). */
	back(): Promise<void>;
	orientation(set?: Orientation): Promise<Orientation>;
	appearance(set?: "light" | "dark"): Promise<"light" | "dark">;
	/** Simulated biometrics: `status`, `enroll`, `unenroll`, `match`, `fail`; see {@link DeviceBiometrics}. */
	readonly biometrics: DeviceBiometrics;
	clipboard(): Promise<string>;
	setClipboard(text: string): Promise<void>;
	/**
	 * Dismisses the soft keyboard when the snapshot shows one, else does nothing. iOS presses Enter
	 * (which may submit the focused field); Android presses back.
	 */
	hideKeyboard(): Promise<void>;
	/** Saves `<attemptDir>/screenshots/NNN-<name>.png` and returns the path. */
	screenshot(name: string): Promise<string>;
	/** The accessibility tree as text (`warden ui snapshot` format). */
	snapshot(options?: SnapshotTextOptions): Promise<string>;
	/**
	 * Waits for a quiet UI: the driver's own settle, else snapshot-hash polling. Resolves `{ quiet, waitedMs }` and,
	 * when known, how it decided: `via` (`stream`: the app's run loop went idle; `snapshot`: the helper fell back to
	 * comparing screens; `hash`: warden polled snapshot hashes, always on Android), a `reason` for a not-quiet end
	 * (`frontmost_mismatch`: the launched app never came to the front) and the `frontmostPid` the helper saw.
	 */
	settle(options?: SettleOptions): Promise<SettleDetail>;
	/**
	 * The app's JS runtime over Metro (evaluate, React tree, console, network, reload); `undefined` without
	 * `WARDEN_METRO_URL` (a release build). The first access starts attaching, so console capture begins there.
	 */
	readonly devtools: DeviceDevtools | undefined;
	/**
	 * Perf profiling of the app (`warden perf` over the CLI that started the run): `start`, `mark`, then `stop` for the
	 * typed report. The report is copied under the attempt's `perf/`; budgets from `warden.config.ts` fail `stop`.
	 */
	readonly perf: DevicePerf;
	/**
	 * Network conditions: `set("offline" | "3g" | …)`, `during`, `flap`, `fault`, `status`, `reset`. Everything a test
	 * changes is put back when it ends, to the suite's `conditions` (`warden.config.ts`).
	 */
	readonly network: DeviceNetwork;
	/** Simulated location: `set`, `route`, `scenario`, `clear`. Put back when the test ends. */
	readonly location: DeviceLocation;
	/** The device's wall clock: `set`, `advance("2d")`, `during`, `reset`. Needs a driver with a clock op. */
	readonly clock: DeviceClock;
	/** Runtime permissions of the app: `set({ location: "denied", camera: "granted" })`, `reset`. Set before `app.open()`. */
	readonly permissions: DevicePermissions;
	/** Device timezone (`"Asia/Tokyo"`, `null` resets). iOS: for the app launched next. */
	timezone: DeviceConditions["timezone"];
	/** The app's locale (`"fr-FR"`, `null` resets). iOS: for the app launched next. Android 13+. */
	locale: DeviceConditions["locale"];
	/** Text size, bold text, contrast, reduce motion (`null` resets); the result names what the platform skipped. */
	a11y: DeviceConditions["a11y"];
	/** Battery level and charging: real on Android emulators, status bar only on iOS (`cosmetic: true`). */
	battery: DeviceConditions["battery"];
	/** Android: a critical trim-memory signal to the app. iOS: `E_UNSUPPORTED`. */
	memoryWarning: DeviceConditions["memoryWarning"];
	/** iOS: delivers an APNs payload to the app. Android: `E_UNSUPPORTED`. */
	push: DeviceConditions["push"];
	/** Applies network and location changes at times from now; stopped when the test ends. */
	timeline(steps: readonly TimelineStepInput[]): Promise<ConditionRun>;
};

/**
 * What a `device` needs, as values: no env, no runner session. The runner adapter is `fixtures.ts`; `warden ui` and any
 * other host pass the same things directly.
 */
export type DeviceDeps = {
	driver: Driver;
	/** where screenshots go (`<dir>/screenshots/NNN-name.png`); a function is read per call (the runner swaps the attempt dir) */
	artifactsDir: string | (() => string);
	/** the app under test: `openLink` asks whether it is in front; without it nothing is probed */
	appId?: string;
	/** the running attempt's deadline: every driver call honours it; read per call */
	signal?: () => AbortSignal | undefined;
	/** where `screenshot` leaves its trace event, read per call; absent = not traced */
	trace?: () => { write(event: TraceEvent): void } | undefined;
	/** the app's devtools over Metro (a dev client); absent = `device.devtools` is `undefined` */
	devtools?: DevtoolsSource;
	/**
	 * What `openLink` state is kept per: links known to open without a sheet, and links in flight (see `device-link.ts`).
	 * The runner passes its session so every test's device shares it; default one scope per device.
	 */
	linkScope?: object;
	clock?: Clock;
	/** shared with `app` so a launch knows to load the network dylib; default: made here from `conditionsEnv` */
	conditions?: DeviceConditions;
	/** what the conditions read when made here (the app, the suite's `conditions`, the lease); default just `appId` */
	conditionsEnv?: ConditionsEnv;
	/** where condition events go (`results.jsonl`) when the conditions are made here; default none */
	conditionSink?: ConditionSink;
	/** records what a spec changed on its lease when the conditions are made here; default none */
	conditionRecorder?: ConditionRecorder;
	/** `device.perf`: how to reach `warden perf` for this device; absent = `perf.start` fails as unavailable */
	perf?: DevicePerfSource;
};

/** What `device.perf` needs besides the artifacts dir: the device, the CLI to run, the budgets, the attempt's file list. */
export type DevicePerfSource = {
	udid: string;
	/** the CLI that started the run (`WARDEN_BIN`); without it (and without `exec`) perf is unavailable */
	wardenBin?: readonly string[] | undefined;
	/** the raw `WARDEN_PERF_BUDGETS` JSON */
	budgets?: string | undefined;
	/** runs `warden …`; default spawns `wardenBin` */
	exec?: PerfExec;
	/** records a file written under the attempt dir in the attempt's file list */
	addFile?: (relative: string) => void;
};

/** The button `device.alert(action)` presses; undefined = none to press. */
class AlertTargets {
	/**
	 * Android `accept`/`dismiss` go by the permission prompt's ids, then the names, then `AlertDialog`'s
	 * `button1`/`button2` (React Native fills those by position).
	 */
	targetFor(info: AlertInfo, action: AlertAction, platform: Platform): Element | undefined {
		const { buttons } = info;
		if (action === "accept") {
			if (platform !== "android") return alertButtons.firstOf(buttons, ACCEPT_BUTTONS) ?? buttons[buttons.length - 1];
			return (
				this.androidButton(buttons, ANDROID_PERMISSION_ALLOW_IDS) ??
				alertButtons.firstOf(buttons, ACCEPT_BUTTONS) ??
				this.androidButton(buttons, [ANDROID_POSITIVE_ID]) ??
				buttons[buttons.length - 1]
			);
		}
		// Cancel on "Open in …?" only throws away a link the test opened: open it
		if (action === "dismiss" && deviceLinks.isOpenInSheet(info)) return alertButtons.findButton(buttons, "Open");
		if (action === "dismiss") {
			if (platform !== "android") return alertButtons.firstOf(buttons, DISMISS_BUTTONS) ?? buttons[0];
			return (
				this.androidButton(buttons, ANDROID_PERMISSION_DENY_IDS) ??
				alertButtons.firstOf(buttons, DISMISS_BUTTONS) ??
				this.androidButton(buttons, [ANDROID_NEGATIVE_ID]) ??
				buttons[0]
			);
		}
		const target = alertButtons.findButton(buttons, action.button);
		if (target === undefined) {
			throw new E2eError(
				"ACTION_FAILED",
				`alert has no "${action.button}" button (buttons: ${this.buttonNames(info)})`
			);
		}
		return target;
	}

	buttonNames(info: AlertInfo): string {
		return info.buttons.map((b) => alertButtons.nameOf(b) ?? "?").join(", ");
	}

	/** The first of `buttons` whose id is in `ids`, in that list's order. */
	private androidButton(buttons: readonly Element[], ids: readonly string[]): Element | undefined {
		for (const id of ids) {
			const found = buttons.find((button) => button.identifier === id);
			if (found !== undefined) return found;
		}
		return undefined;
	}
}

const alertTargets = new AlertTargets();

const ALERT_PRESS_ATTEMPTS = 3;
const ALERT_PRESS_SETTLE_MS = 250;

/** The {@link Device} over a {@link Driver}: one per test attempt, every call honours the attempt's signal. */
export class DeviceImpl implements Device {
	private readonly driver: Driver;
	private readonly artifactsDir: string | (() => string);
	private readonly appId: string;
	private readonly clockSource: Clock;
	private readonly linkScope: object;
	private readonly devtoolsSource: DevtoolsSource | undefined;
	private readonly readAlert: DeviceAlertReader["read"];
	private readonly issued = new Map<string, number>();
	private devtoolsFacade: DeviceDevtools | undefined;

	readonly perf: DevicePerf;
	readonly network: DeviceNetwork;
	readonly location: DeviceLocation;
	readonly clock: DeviceClock;
	readonly permissions: DevicePermissions;
	readonly timezone: DeviceConditions["timezone"];
	readonly locale: DeviceConditions["locale"];
	readonly a11y: DeviceConditions["a11y"];
	readonly battery: DeviceConditions["battery"];
	readonly memoryWarning: DeviceConditions["memoryWarning"];
	readonly push: DeviceConditions["push"];
	readonly timeline: Device["timeline"];

	constructor(private readonly deps: DeviceDeps) {
		const { driver, artifactsDir, perf: perfDeps } = deps;
		const appId = deps.appId ?? "";
		this.driver = driver;
		this.artifactsDir = artifactsDir;
		this.appId = appId;
		this.clockSource = deps.clock ?? systemClock;
		this.linkScope = deps.linkScope ?? {};
		this.devtoolsSource = deps.devtools;
		this.readAlert = new DeviceAlertReader({ driver, clock: this.clockSource, signal: () => this.signal() }).read;
		const conditionsEnv = deps.conditionsEnv ?? { bundleId: appId };
		const conditions =
			deps.conditions ??
			new DeviceConditionsImpl({
				driver,
				env: conditionsEnv,
				signal: () => deps.signal?.(),
				...(deps.conditionSink === undefined ? {} : { sink: deps.conditionSink }),
				...(deps.conditionRecorder === undefined ? {} : { recorder: deps.conditionRecorder }),
			});
		this.perf = new DevicePerfImpl({
			exec: perfDeps?.exec ?? perfLauncher.spawnWarden(perfDeps?.wardenBin),
			udid: perfDeps?.udid ?? "",
			budgets: perfBudgets.parse(perfDeps?.budgets),
			attemptDir: () => this.currentArtifactsDir(),
			...(perfDeps?.addFile ? { addFile: perfDeps.addFile } : {}),
			...(perfDeps === undefined || (perfDeps.wardenBin === undefined && perfDeps.exec === undefined)
				? { unavailable: "WARDEN_BIN is not set (run the spec with `warden e2e`)" }
				: {}),
		});
		this.network = conditions.network;
		this.location = conditions.location;
		this.clock = conditions.clock;
		this.permissions = conditions.permissions;
		this.timezone = conditions.timezone;
		this.locale = conditions.locale;
		this.a11y = conditions.a11y;
		this.battery = conditions.battery;
		this.memoryWarning = conditions.memoryWarning;
		this.push = conditions.push;
		this.timeline = (steps) => conditions.timeline(steps);
		conditionRegistry.register(this, conditions.internals);
	}

	get devtools(): DeviceDevtools | undefined {
		const source = this.devtoolsSource;
		if (source === undefined) return undefined;
		if (this.devtoolsFacade === undefined) {
			this.devtoolsFacade = new DeviceDevtoolsFacade(source);
			void source.devtools();
		}
		return this.devtoolsFacade;
	}

	readonly alert = async (action: AlertAction): Promise<boolean> => {
		const { driver } = this;
		// the bridge also sees what the app itself shows (Keychain "Save Password?"), so it answers "none" alone
		const info = await this.readAlert("axbridge");
		if (info === null || info.buttons.length === 0) return false;
		// openLink is answering this sheet itself and must see it to know the link has one
		if (deviceLinks.isOpenInSheet(info) && typeof action === "string" && deviceLinks.linkInFlight(this.linkScope))
			return false;
		if (driver.platform === "android" && alertButtons.isAutofillSaveSheet(info.buttons))
			return this.closeAutofillSheet(action);
		const target = alertTargets.targetFor(info, action, driver.platform);
		if (target === undefined) return false;
		await this.pressAlertButton(target, "press alert button");
		if (driver.platform === "ios") await this.confirmAlertGone(info, target);
		return true;
	};

	readonly openLink = async (url: string, options: OpenLinkOptions = {}): Promise<void> => {
		const { driver } = this;
		const waitMs = options.waitMs ?? OPEN_LINK_WAIT_MS;
		if (!Number.isFinite(waitMs) || waitMs < 0) {
			throw new E2eError("INVALID_ARGUMENT", `openLink waitMs must be a non-negative number, got ${String(waitMs)}`);
		}
		await driverCalls.unwrap(() => driver.app.openUrl(url), `open ${url}`, this.signal());
		const answersSheet = options.accept !== false && driver.platform === "ios" && driver.capabilities.alerts;
		if (!answersSheet && options.until === undefined) return;
		await deviceLinks.whileLinkInFlight(this.linkScope, () =>
			deviceLinks.waitForLink(
				{
					clock: this.clockSource,
					readAlert: this.readAlert,
					press: (button) => this.pressAlertButton(button, "accept open-in sheet"),
					appInFront: () => this.appInFront(),
					isVisible: (locator) => this.isVisible(locator),
					sheetless: deviceLinks.sheetlessFor(this.linkScope),
				},
				{
					key: deviceLinks.linkKey(url),
					answersSheet,
					waitMs,
					...(options.until === undefined ? {} : { until: options.until }),
				}
			)
		);
	};

	readonly home = async (): Promise<void> => {
		await driverCalls.unwrap(() => this.driver.pressButton("home"), "press home", this.signal());
	};

	readonly back = async (): Promise<void> => {
		if (this.driver.platform === "ios") {
			throw new E2eError("INVALID_ARGUMENT", "device.back() is Android only: iOS has no back key");
		}
		await driverCalls.unwrap(() => this.driver.pressButton("back"), "press back", this.signal());
	};

	readonly orientation = (set?: Orientation): Promise<Orientation> =>
		driverCalls.unwrap(() => this.driver.orientation(set), "orientation", this.signal());

	readonly appearance = (set?: "light" | "dark"): Promise<"light" | "dark"> =>
		driverCalls.unwrap(() => this.driver.appearance(set), "appearance", this.signal());

	readonly biometrics: DeviceBiometrics = {
		status: () => this.biometric("status"),
		enroll: () => this.biometric("enroll"),
		unenroll: () => this.biometric("unenroll"),
		match: () => this.biometric("match"),
		fail: () => this.biometric("fail"),
	};

	readonly clipboard = (): Promise<string> =>
		driverCalls.unwrap(() => this.driver.clipboard(), "read clipboard", this.signal());

	readonly setClipboard = async (text: string): Promise<void> => {
		await driverCalls.unwrap(() => this.driver.clipboard(text), "set clipboard", this.signal());
	};

	readonly hideKeyboard = async (): Promise<void> => {
		const { driver } = this;
		const snapshot = await this.readSnapshot();
		if (!snapshot.flat.some((element) => element.role === "keyboard")) return;
		if (driver.platform === "ios") await driverCalls.unwrap(() => driver.key("Enter"), "hide keyboard", this.signal());
		else await driverCalls.unwrap(() => driver.pressButton("back"), "hide keyboard", this.signal());
	};

	readonly screenshot = async (name: string): Promise<string> => {
		const dir = this.currentArtifactsDir();
		const n = this.nextShotNumber(dir);
		this.issued.set(dir, n);
		const path = artifactPaths.screenshotPath(dir, n, name);
		mkdirSync(dirname(path), { recursive: true });
		const shot = await driverCalls.unwrap(() => this.driver.screenshot({ path }), "screenshot", this.signal());
		if (shot.path === undefined && shot.png !== undefined) writeFileSync(path, shot.png);
		this.deps.trace?.()?.write({ type: "screenshot", ts: this.clockSource.now(), kind: "device", label: name, path });
		return path;
	};

	readonly snapshot = async (options: SnapshotTextOptions = {}): Promise<string> => {
		const interactiveOnly = options.interactiveOnly ?? false;
		const snapshot = await this.readSnapshot({ interactiveOnly });
		const rendered = snapshotRenderer.renderSnapshot(snapshot, { interactiveOnly, refs: new Map() });
		return [snapshotRenderer.renderHeader({ snapshot, rendered, interactiveOnly }), ...rendered.lines].join("\n");
	};

	readonly settle = async (options: SettleOptions = {}): Promise<SettleDetail> => {
		const clock = this.clockSource;
		const quietMs = options.quietMs ?? DEFAULT_SETTLE_QUIET_MS;
		const timeoutMs = options.timeout ?? DEFAULT_SETTLE_TIMEOUT_MS;
		const native = await driverCalls.settled(() => this.driver.settle({ quietMs, timeoutMs }), "settle", this.signal());
		if (native.success) return settler.detailOf(native.data);
		if (native.error.code !== "E_UNSUPPORTED") throw driverCalls.toE2eError(native.error, "settle");
		const polled = await settler.byHash(async () => settler.snapshotHash(await this.readSnapshot()), {
			quietMs,
			timeoutMs,
			now: clock.now,
			sleep: clock.sleep,
		});
		return { ...polled, via: "hash" };
	};

	/** the signal is read per call: the runner swaps it for every attempt */
	private signal(): AbortSignal | undefined {
		return this.deps.signal?.();
	}

	private currentArtifactsDir(): string {
		return typeof this.artifactsDir === "string" ? this.artifactsDir : this.artifactsDir();
	}

	private nextShotNumber(dir: string): number {
		let highest = this.issued.get(dir) ?? 0;
		try {
			for (const file of readdirSync(join(dir, "screenshots"))) {
				const n = /^(\d{3})-/.exec(file)?.[1];
				if (n !== undefined) highest = Math.max(highest, Number(n));
			}
		} catch {
			// no screenshots directory yet
		}
		return highest + 1;
	}

	private biometric(op: BiometricOp): Promise<BiometricState> {
		return driverCalls.unwrap(() => this.driver.biometrics(op), `biometrics ${op}`, this.signal());
	}

	private async pressAlertButton(button: Element, action: string): Promise<void> {
		await driverCalls.unwrap(() => this.driver.tap(alertButtons.centre(button)), action, this.signal());
	}

	/** "Never" and "Continue" both change the user's Google account: only Back closes the autofill "Save password?" sheet. */
	private async closeAutofillSheet(action: AlertAction): Promise<true> {
		if (typeof action !== "string") {
			throw new E2eError(
				"ACTION_FAILED",
				`the autofill "Save password?" sheet is closed with Back only, never "${action.button}": use accept or dismiss`
			);
		}
		await driverCalls.unwrap(() => this.driver.pressButton("back"), "dismiss autofill save sheet", this.signal());
		return true;
	}

	/**
	 * A press on an iOS sheet that is still animating in (LocalAuthentication's "Face Not Recognized") lands on nothing and
	 * reports success, so `answered` is only true once the alert is gone or has become a different one. Presses again
	 * (`ALERT_PRESS_ATTEMPTS` in all) while the same buttons show; `ACTION_FAILED` when they never leave.
	 */
	private async confirmAlertGone(shown: AlertInfo, pressed: Element): Promise<void> {
		let target = pressed;
		for (let attempt = 1; ; attempt += 1) {
			await this.clockSource.sleep(ALERT_PRESS_SETTLE_MS);
			const now = await this.readAlert("axbridge", 0);
			if (now === null || alertTargets.buttonNames(now) !== alertTargets.buttonNames(shown)) return;
			if (attempt >= ALERT_PRESS_ATTEMPTS) {
				throw new E2eError(
					"ACTION_FAILED",
					`alert still showing after pressing "${alertButtons.nameOf(pressed) ?? "?"}" ${ALERT_PRESS_ATTEMPTS} times (buttons: ${alertTargets.buttonNames(now)})`
				);
			}
			target = now.buttons.find((b) => alertButtons.nameOf(b) === alertButtons.nameOf(pressed)) ?? target;
			await this.pressAlertButton(target, "press alert button again");
		}
	}

	/** Whether the app under test is in front; `undefined` when the driver (or the bundle id) cannot say. */
	private async appInFront(): Promise<boolean | undefined> {
		const { driver, appId } = this;
		if (appId === "" || !alertCapabilities.canProbeFrontmost(driver)) return undefined;
		const result = await driverCalls.settled(() => driver.isFrontmost(appId), "probe frontmost app", this.signal());
		return result.success ? result.data : undefined;
	}

	/** `until.isVisible()`; a locator that cannot answer yet (several matches, a driver hiccup) is not visible yet. */
	private async isVisible(locator: Locator): Promise<boolean> {
		try {
			return await locator.isVisible();
		} catch (error) {
			if (this.signal()?.aborted) throw error;
			return false;
		}
	}

	private readSnapshot(opts?: { interactiveOnly?: boolean }): Promise<Snapshot> {
		return driverCalls.unwrap(() => this.driver.snapshot(opts), "snapshot", this.signal());
	}
}

/** Builds the conditions of one attempt's device. */
export class SessionConditions {
	/** The conditions of one attempt's device: events go to the session's `results.jsonl`, calls honour its signal. */
	create(
		session: Pick<FixtureSession, "results" | "signal">,
		driver: Driver,
		env: ConditionsEnv,
		recorder: ConditionRecorder | undefined = leaseRecorderResolver.forEnv(env)
	): DeviceConditions {
		const sink = conditionRegistry.sinkFor(session);
		return new DeviceConditionsImpl({
			driver,
			env,
			signal: () => session.signal,
			...(sink === undefined ? {} : { sink }),
			...(recorder === undefined ? {} : { recorder }),
		});
	}
}

export const sessionConditions = new SessionConditions();
