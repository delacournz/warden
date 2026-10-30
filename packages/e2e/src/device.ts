import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	ACCEPT_BUTTONS,
	ANDROID_NEGATIVE_ID,
	ANDROID_PERMISSION_ALLOW_IDS,
	ANDROID_PERMISSION_DENY_IDS,
	ANDROID_POSITIVE_ID,
	centre,
	DISMISS_BUTTONS,
	findButton,
	firstOf,
	isAutofillSaveSheet,
	nameOf,
} from "./alert-buttons";
import { createAlertReader } from "./alert-reader";
import {
	type ConditionRun,
	conditionSinkFor,
	createDeviceConditions,
	type DeviceClock,
	type DeviceConditions,
	type DeviceLocation,
	type DeviceNetwork,
	type DevicePermissions,
	registerConditions,
	type TimelineStepInput,
} from "./conditions/device-conditions";
import { type ConditionRecorder, leaseRecorderFor } from "./conditions/lease-recorder";
import { createDeviceDevtools, type DeviceDevtools } from "./device-devtools";
import {
	isOpenInSheet,
	linkInFlight,
	linkKey,
	OPEN_LINK_WAIT_MS,
	sheetlessFor,
	waitForLink,
	whileLinkInFlight,
} from "./device-link";
import { canProbeFrontmost } from "./driver/alerts";
import type {
	AlertInfo,
	BiometricOp,
	BiometricState,
	Driver,
	Element,
	Orientation,
	Platform,
	Snapshot,
} from "./driver/driver.types";
import {
	DEFAULT_SETTLE_QUIET_MS,
	DEFAULT_SETTLE_TIMEOUT_MS,
	type SettleDetail,
	settleByHash,
	settleDetailOf,
	snapshotHash,
} from "./driver/settle";
import { settled, toE2eError, unwrap } from "./driver/unwrap";
import type { E2eEnv } from "./env";
import { E2eError } from "./errors";
import { type Clock, type FixtureSession, systemClock } from "./fixture-session";
import { parseBudgets } from "./perf/budgets";
import { createDevicePerf, type DevicePerf, type PerfExec, spawnWarden } from "./perf/device-perf";
import { screenshotPath } from "./runner/artifacts";
import type { Locator } from "./screen/locator";
import { renderHeader, renderSnapshot } from "./screen/render";

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

export type DeviceDeps = {
	session: FixtureSession;
	driver: Driver;
	env: E2eEnv;
	clock?: Clock;
	/** runs `warden …` for `device.perf`; default spawns `WARDEN_BIN` */
	perfExec?: PerfExec;
	/** shared with `app` so a launch knows to load the network dylib; default: made here */
	conditions?: DeviceConditions;
};

function nextShotNumber(dir: string, issued: ReadonlyMap<string, number>): number {
	let highest = issued.get(dir) ?? 0;
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

/** The first of `buttons` whose id is in `ids`, in that list's order. */
function androidButton(buttons: readonly Element[], ids: readonly string[]): Element | undefined {
	for (const id of ids) {
		const found = buttons.find((button) => button.identifier === id);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** The button `device.alert(action)` presses; undefined = none to press. Android `accept`/`dismiss` go by the permission
 * prompt's ids, then the names, then `AlertDialog`'s `button1`/`button2` (React Native fills those by position). */
const ALERT_PRESS_ATTEMPTS = 3;
const ALERT_PRESS_SETTLE_MS = 250;

function buttonNames(info: AlertInfo): string {
	return info.buttons.map((b) => nameOf(b) ?? "?").join(", ");
}

function alertTarget(info: AlertInfo, action: AlertAction, platform: Platform): Element | undefined {
	const { buttons } = info;
	if (action === "accept") {
		if (platform !== "android") return firstOf(buttons, ACCEPT_BUTTONS) ?? buttons[buttons.length - 1];
		return (
			androidButton(buttons, ANDROID_PERMISSION_ALLOW_IDS) ??
			firstOf(buttons, ACCEPT_BUTTONS) ??
			androidButton(buttons, [ANDROID_POSITIVE_ID]) ??
			buttons[buttons.length - 1]
		);
	}
	// Cancel on "Open in …?" only throws away a link the test opened: open it
	if (action === "dismiss" && isOpenInSheet(info)) return findButton(buttons, "Open");
	if (action === "dismiss") {
		if (platform !== "android") return firstOf(buttons, DISMISS_BUTTONS) ?? buttons[0];
		return (
			androidButton(buttons, ANDROID_PERMISSION_DENY_IDS) ??
			firstOf(buttons, DISMISS_BUTTONS) ??
			androidButton(buttons, [ANDROID_NEGATIVE_ID]) ??
			buttons[0]
		);
	}
	const target = findButton(buttons, action.button);
	if (target === undefined) {
		const names = buttons.map((b) => nameOf(b) ?? "?").join(", ");
		throw new E2eError("ACTION_FAILED", `alert has no "${action.button}" button (buttons: ${names})`);
	}
	return target;
}

export function createDevice({
	session,
	driver,
	env,
	clock = systemClock,
	perfExec,
	conditions = createSessionConditions(session, driver, env),
}: DeviceDeps): Device {
	const issued = new Map<string, number>();
	// the signal is read per call: the runner swaps it for every attempt
	const signal = (): AbortSignal | undefined => session.signal;
	const biometric = (op: BiometricOp): Promise<BiometricState> =>
		unwrap(() => driver.biometrics(op), `biometrics ${op}`, signal());

	const pressAlertButton = async (button: Element, action: string): Promise<void> => {
		await unwrap(() => driver.tap(centre(button)), action, signal());
	};

	const readAlert = createAlertReader({ driver, clock, signal });

	/**
	 * A press on an iOS sheet that is still animating in (LocalAuthentication's "Face Not Recognized") lands on nothing and
	 * reports success, so `answered` is only true once the alert is gone or has become a different one. Presses again
	 * (`ALERT_PRESS_ATTEMPTS` in all) while the same buttons show; `ACTION_FAILED` when they never leave.
	 */
	const confirmAlertGone = async (shown: AlertInfo, pressed: Element): Promise<void> => {
		let target = pressed;
		for (let attempt = 1; ; attempt += 1) {
			await clock.sleep(ALERT_PRESS_SETTLE_MS);
			const now = await readAlert("axbridge", 0);
			if (now === null || buttonNames(now) !== buttonNames(shown)) return;
			if (attempt >= ALERT_PRESS_ATTEMPTS) {
				throw new E2eError(
					"ACTION_FAILED",
					`alert still showing after pressing "${nameOf(pressed) ?? "?"}" ${ALERT_PRESS_ATTEMPTS} times (buttons: ${buttonNames(now)})`
				);
			}
			target = now.buttons.find((b) => nameOf(b) === nameOf(pressed)) ?? target;
			await pressAlertButton(target, "press alert button again");
		}
	};

	/** Whether the app under test is in front; `undefined` when the driver (or the bundle id) cannot say. */
	const appInFront = async (): Promise<boolean | undefined> => {
		if (env.bundleId === "" || !canProbeFrontmost(driver)) return undefined;
		const result = await settled(() => driver.isFrontmost(env.bundleId), "probe frontmost app", signal());
		return result.success ? result.data : undefined;
	};

	/** `until.isVisible()`; a locator that cannot answer yet (several matches, a driver hiccup) is not visible yet. */
	const isVisible = async (locator: Locator): Promise<boolean> => {
		try {
			return await locator.isVisible();
		} catch (error) {
			if (signal()?.aborted) throw error;
			return false;
		}
	};

	const readSnapshot = (opts?: { interactiveOnly?: boolean }): Promise<Snapshot> =>
		unwrap(() => driver.snapshot(opts), "snapshot", signal());

	const { devtools: attach, peekDevtools } = session;
	let devtools: DeviceDevtools | undefined;
	const lazyDevtools = (): DeviceDevtools | undefined => {
		if (env.metroUrl === undefined || attach === undefined || peekDevtools === undefined) return undefined;
		if (devtools === undefined) {
			devtools = createDeviceDevtools({
				devtools: () => attach.call(session),
				peekDevtools: () => peekDevtools.call(session),
			});
			void attach.call(session);
		}
		return devtools;
	};

	const perf = createDevicePerf({
		exec: perfExec ?? spawnWarden(env.wardenBin),
		udid: env.udid,
		budgets: parseBudgets(env.perfBudgets),
		attemptDir: () => session.attemptDir,
		addFile: (relative) => session.attempt?.files.add(relative),
		...(env.wardenBin === undefined && perfExec === undefined
			? { unavailable: "WARDEN_BIN is not set (run the spec with `warden e2e`)" }
			: {}),
	});

	const device: Device = {
		get devtools() {
			return lazyDevtools();
		},
		perf,
		network: conditions.network,
		location: conditions.location,
		clock: conditions.clock,
		permissions: conditions.permissions,
		timezone: conditions.timezone,
		locale: conditions.locale,
		a11y: conditions.a11y,
		battery: conditions.battery,
		memoryWarning: conditions.memoryWarning,
		push: conditions.push,
		timeline: (steps) => conditions.timeline(steps),

		async alert(action) {
			// the bridge also sees what the app itself shows (Keychain "Save Password?"), so it answers "none" alone
			const info = await readAlert("axbridge");
			if (info === null || info.buttons.length === 0) return false;
			// openLink is answering this sheet itself and must see it to know the link has one
			if (isOpenInSheet(info) && typeof action === "string" && linkInFlight(session)) return false;
			// "Never" and "Continue" both change the user's Google account: only Back closes the sheet
			if (driver.platform === "android" && isAutofillSaveSheet(info.buttons)) {
				if (typeof action !== "string") {
					throw new E2eError(
						"ACTION_FAILED",
						`the autofill "Save password?" sheet is closed with Back only, never "${action.button}": use accept or dismiss`
					);
				}
				await unwrap(() => driver.pressButton("back"), "dismiss autofill save sheet", signal());
				return true;
			}
			const target = alertTarget(info, action, driver.platform);
			if (target === undefined) return false;
			await pressAlertButton(target, "press alert button");
			if (driver.platform === "ios") await confirmAlertGone(info, target);
			return true;
		},

		async openLink(url, options = {}) {
			const waitMs = options.waitMs ?? OPEN_LINK_WAIT_MS;
			if (!Number.isFinite(waitMs) || waitMs < 0) {
				throw new E2eError("INVALID_ARGUMENT", `openLink waitMs must be a non-negative number, got ${String(waitMs)}`);
			}
			await unwrap(() => driver.app.openUrl(url), `open ${url}`, signal());
			const answersSheet = options.accept !== false && driver.platform === "ios" && driver.capabilities.alerts;
			if (!answersSheet && options.until === undefined) return;
			await whileLinkInFlight(session, () =>
				waitForLink(
					{
						clock,
						readAlert,
						press: (button) => pressAlertButton(button, "accept open-in sheet"),
						appInFront,
						isVisible,
						sheetless: sheetlessFor(session),
					},
					{ key: linkKey(url), answersSheet, waitMs, ...(options.until === undefined ? {} : { until: options.until }) }
				)
			);
		},

		async home() {
			await unwrap(() => driver.pressButton("home"), "press home", signal());
		},

		async back() {
			if (driver.platform === "ios") {
				throw new E2eError("INVALID_ARGUMENT", "device.back() is Android only: iOS has no back key");
			}
			await unwrap(() => driver.pressButton("back"), "press back", signal());
		},

		orientation(set) {
			return unwrap(() => driver.orientation(set), "orientation", signal());
		},

		appearance(set) {
			return unwrap(() => driver.appearance(set), "appearance", signal());
		},

		biometrics: {
			status: () => biometric("status"),
			enroll: () => biometric("enroll"),
			unenroll: () => biometric("unenroll"),
			match: () => biometric("match"),
			fail: () => biometric("fail"),
		},

		clipboard() {
			return unwrap(() => driver.clipboard(), "read clipboard", signal());
		},

		async setClipboard(text) {
			await unwrap(() => driver.clipboard(text), "set clipboard", signal());
		},

		async hideKeyboard() {
			const snapshot = await readSnapshot();
			if (!snapshot.flat.some((element) => element.role === "keyboard")) return;
			if (driver.platform === "ios") await unwrap(() => driver.key("Enter"), "hide keyboard", signal());
			else await unwrap(() => driver.pressButton("back"), "hide keyboard", signal());
		},

		async screenshot(name) {
			const dir = session.attemptDir ?? join(session.out, "adhoc");
			const n = nextShotNumber(dir, issued);
			issued.set(dir, n);
			const path = screenshotPath(dir, n, name);
			mkdirSync(dirname(path), { recursive: true });
			const shot = await unwrap(() => driver.screenshot({ path }), "screenshot", signal());
			if (shot.path === undefined && shot.png !== undefined) writeFileSync(path, shot.png);
			session.trace?.write({ type: "screenshot", ts: clock.now(), kind: "device", label: name, path });
			return path;
		},

		async snapshot(options = {}) {
			const interactiveOnly = options.interactiveOnly ?? false;
			const snapshot = await readSnapshot({ interactiveOnly });
			const rendered = renderSnapshot(snapshot, { interactiveOnly, refs: new Map() });
			return [renderHeader({ snapshot, rendered, interactiveOnly }), ...rendered.lines].join("\n");
		},

		async settle(options = {}) {
			const quietMs = options.quietMs ?? DEFAULT_SETTLE_QUIET_MS;
			const timeoutMs = options.timeout ?? DEFAULT_SETTLE_TIMEOUT_MS;
			const native = await settled(() => driver.settle({ quietMs, timeoutMs }), "settle", signal());
			if (native.success) return settleDetailOf(native.data);
			if (native.error.code !== "E_UNSUPPORTED") throw toE2eError(native.error, "settle");
			const polled = await settleByHash(async () => snapshotHash(await readSnapshot()), {
				quietMs,
				timeoutMs,
				now: clock.now,
				sleep: clock.sleep,
			});
			return { ...polled, via: "hash" };
		},
	};
	registerConditions(device, conditions.internals);
	return device;
}

/** The conditions of one attempt's device: events go to the session's `results.jsonl`, calls honour its signal. */
export function createSessionConditions(
	session: FixtureSession,
	driver: Driver,
	env: E2eEnv,
	recorder: ConditionRecorder | undefined = leaseRecorderFor(env)
): DeviceConditions {
	const sink = conditionSinkFor(session);
	return createDeviceConditions({
		driver,
		env,
		signal: () => session.signal,
		...(sink === undefined ? {} : { sink }),
		...(recorder === undefined ? {} : { recorder }),
	});
}
