import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevice } from "./device";
import { sheetlessFor } from "./device-link";
import { type ElementSpec, el, type FakeDriver, failWith, fakeDriver, snapshotOf } from "./driver/driver.testing";
import type { Platform, Snapshot } from "./driver/driver.types";
import type { E2eEnv } from "./env";
import type { E2eError } from "./errors";
import type { Clock, FixtureSession } from "./fixture-session";
import { createScreen } from "./screen/screen";
import { testHost } from "./screen/screen.testing";

const env: E2eEnv = {
	udid: "UDID",
	platform: "ios",
	bundleId: "com.example.app",
	launchArgs: [],
	out: "/tmp/out",
	timeoutMs: 1000,
	actionTimeoutMs: 1000,
	assertionTimeoutMs: 1000,
	logTimestamps: false,
};

function fakeClock(): Clock & { time: () => number } {
	let t = 0;
	return {
		now: () => t,
		sleep: async (ms) => {
			t += ms;
		},
		time: () => t,
	};
}

const button = (label: string): ElementSpec => el("button", { label });
const alertOf = (...labels: string[]): ElementSpec => el("alert", { label: "Title", children: labels.map(button) });

function setup(
	opts: { screens?: Snapshot[] | (() => Snapshot); platform?: Platform; session?: Partial<FixtureSession> } = {}
) {
	const platform = opts.platform ?? "ios";
	const driver = fakeDriver({ screens: opts.screens ?? [snapshotOf([], { platform })], platform });
	const clock = fakeClock();
	const session: FixtureSession = { out: "/tmp/out", ...opts.session };
	const device = createDevice({ session, driver, env: { ...env, platform }, clock });
	return { driver, device, clock };
}

const withAlert = (...labels: string[]): Snapshot => snapshotOf([alertOf(...labels)]);

/** the y of the button's row centre in a snapshot with an alert at row 0 */
const rowCentre = (index: number): { x: number; y: number } => ({ x: 195, y: index * 50 + 22 });

describe("device.alert", () => {
	test("accept presses the first heuristic match by list order", async () => {
		const { device, driver } = setup({ screens: [withAlert("Cancel", "Allow Once", "Allow While Using App")] });
		expect(await device.alert("accept")).toBe(true);
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(3));
	});

	test("accept matches curly apostrophes and case", async () => {
		const { device, driver } = setup({ screens: [withAlert("Don’t Allow", "ok")] });
		await device.alert("accept");
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(2));
	});

	test("accept falls back to the last button", async () => {
		const { device, driver } = setup({ screens: [withAlert("Delete", "Keep")] });
		await device.alert("accept");
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(2));
	});

	test("dismiss presses the first dismiss word", async () => {
		const { device, driver } = setup({ screens: [withAlert("Save Password", "Not Now")] });
		expect(await device.alert("dismiss")).toBe(true);
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(2));
	});

	test("dismiss falls back to the first button", async () => {
		const { device, driver } = setup({ screens: [withAlert("Delete", "Keep")] });
		await device.alert("dismiss");
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(1));
	});

	test("{button} presses that button", async () => {
		const { device, driver } = setup({ screens: [withAlert("One", "Two", "Three")] });
		expect(await device.alert({ button: "two" })).toBe(true);
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(2));
	});

	test("{button} that is absent is ACTION_FAILED listing the buttons", async () => {
		const { device } = setup({ screens: [withAlert("One")] });
		const error = await device.alert({ button: "Nope" }).catch((e: unknown) => e);
		expect((error as E2eError).code).toBe("ACTION_FAILED");
		expect((error as E2eError).message).toContain("One");
	});

	test("no alert returns false without tapping", async () => {
		const { device, driver } = setup();
		expect(await device.alert("accept")).toBe(false);
		expect(driver.callsOf("tap")).toHaveLength(0);
	});

	test("a transient AX failure is retried, not thrown", async () => {
		let failures = 2;
		const driver = fakeDriver({
			screens: [withAlert("Cancel", "OK")],
			onCall: (c) => (c.method === "alert" && failures-- > 0 ? failWith("E_AX_UNAVAILABLE") : undefined),
		});
		const device = createDevice({ session: { out: "/tmp/out" }, driver, env, clock: fakeClock() });
		expect(await device.alert("accept")).toBe(true);
		expect(driver.callsOf("alert")).toHaveLength(3);
	});

	test("driver failures become E2eError", async () => {
		const driver = fakeDriver({
			screens: [snapshotOf([])],
			onCall: (c) => (c.method === "alert" ? failWith("E_HELPER_CRASHED") : undefined),
		});
		const device = createDevice({ session: { out: "/tmp/out" }, driver, env, clock: fakeClock() });
		const error = await device.alert("accept").catch((e: unknown) => e);
		expect((error as E2eError).code).toBe("DRIVER");
	});

	test("a driver with one alert() answers 'no alert' with one read and no sleeps", async () => {
		const { device, driver, clock } = setup();
		expect(await device.alert("dismiss")).toBe(false);
		expect(driver.calls.map((c) => c.method)).toEqual(["alert"]);
		expect(clock.time()).toBe(0);
	});
});

describe("device.alert on Android permission prompts", () => {
	const pc = (id: string, label: string): ElementSpec => el("button", { id, text: label });
	/** the permissioncontroller dialog as the fake reads it: an alert holding the buttons in layout order */
	const permissionPrompt = (...buttons: ElementSpec[]): Snapshot =>
		snapshotOf([el("alert", { label: "Allow Demo to access this device's location?", children: buttons })], {
			platform: "android",
		});
	const locationPrompt = (labels: [string, string, string]): Snapshot =>
		permissionPrompt(
			pc("permission_allow_foreground_only_button", labels[0]),
			pc("permission_allow_one_time_button", labels[1]),
			pc("permission_deny_button", labels[2])
		);

	test('accept on the three-button prompt presses "While using the app", not the last button ("Don\'t allow")', async () => {
		const { device, driver } = setup({
			platform: "android",
			screens: [locationPrompt(["While using the app", "Only this time", "Don't allow"])],
		});
		expect(await device.alert("accept")).toBe(true);
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(1));
	});

	test("accept goes by the button id, so a translated prompt is granted too", async () => {
		const { device, driver } = setup({
			platform: "android",
			screens: [locationPrompt(["Bei Nutzung der App", "Nur dieses Mal", "Nicht zulassen"])],
		});
		await device.alert("accept");
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(1));
	});

	test("the ids are tried in ANDROID_ALLOW_IDS order, not layout order", async () => {
		const { device, driver } = setup({
			platform: "android",
			screens: [
				permissionPrompt(
					pc("permission_allow_one_time_button", "Only this time"),
					pc("permission_allow_foreground_only_button", "While using the app"),
					pc("permission_deny_button", "Don't allow")
				),
			],
		});
		await device.alert("accept");
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(2));
	});

	test("AlertDialog: accept presses the positive button1 whatever it says", async () => {
		const { device, driver } = setup({
			platform: "android",
			screens: [permissionPrompt(pc("button1", "Löschen"), pc("button2", "Abbrechen"))],
		});
		await device.alert("accept");
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(1));
	});

	test('dismiss on the three-button prompt presses "Don\'t allow"', async () => {
		const { device, driver } = setup({
			platform: "android",
			screens: [locationPrompt(["While using the app", "Only this time", "Don't allow"])],
		});
		expect(await device.alert("dismiss")).toBe(true);
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(3));
	});

	test("dismiss goes by the button id too, so a translated prompt is denied, not granted", async () => {
		const { device, driver } = setup({
			platform: "android",
			screens: [locationPrompt(["Bei Nutzung der App", "Nur dieses Mal", "Nicht zulassen"])],
		});
		expect(await device.alert("dismiss")).toBe(true);
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(3));
	});

	test("dismiss: the ids are tried in ANDROID_DENY_IDS order; AlertDialog's negative button2 whatever it says", async () => {
		const prompt = setup({
			platform: "android",
			screens: [
				permissionPrompt(
					pc("permission_allow_foreground_only_button", "Bei Nutzung der App"),
					pc("permission_deny_and_dont_ask_again_button", "Nicht zulassen und nicht mehr fragen"),
					pc("permission_deny_button", "Nicht zulassen")
				),
			],
		});
		await prompt.device.alert("dismiss");
		expect(prompt.driver.callsOf("tap")[0]?.point).toEqual(rowCentre(3));
		const dialog = setup({
			platform: "android",
			screens: [permissionPrompt(pc("button1", "Löschen"), pc("button2", "Abbrechen"))],
		});
		await dialog.device.alert("dismiss");
		expect(dialog.driver.callsOf("tap")[0]?.point).toEqual(rowCentre(2));
	});

	test("React Native alerts fill buttons by position: dismiss presses Cancel by name before AlertDialog's button2", async () => {
		// Alert.alert([Cancel, Delete, Keep]): neutral button3 = Cancel, negative button2 = Delete, positive button1 = Keep
		const three = setup({
			platform: "android",
			screens: [permissionPrompt(pc("button3", "Cancel"), pc("button2", "Delete"), pc("button1", "Keep"))],
		});
		await three.device.alert("dismiss");
		expect(three.driver.callsOf("tap")[0]?.point).toEqual(rowCentre(1));
		// Alert.alert([OK, Cancel]): negative button2 = OK, positive button1 = Cancel
		const two = setup({
			platform: "android",
			screens: [permissionPrompt(pc("button2", "OK"), pc("button1", "Cancel"))],
		});
		await two.device.alert("dismiss");
		expect(two.driver.callsOf("tap")[0]?.point).toEqual(rowCentre(2));
	});

	test("React Native alerts: accept presses OK by name before AlertDialog's button1", async () => {
		// Alert.alert([OK, Cancel]): negative button2 = OK, positive button1 = Cancel
		const { device, driver } = setup({
			platform: "android",
			screens: [permissionPrompt(pc("button2", "OK"), pc("button1", "Cancel"))],
		});
		await device.alert("accept");
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(1));
	});

	test("the Android labels are accept words by name as well", async () => {
		const { device, driver } = setup({ screens: [withAlert("Don't allow", "Only this time")] });
		await device.alert("accept");
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(2));
		const second = setup({ screens: [withAlert("While using the app", "Don't allow")] });
		await second.device.alert("accept");
		expect(second.driver.callsOf("tap")[0]?.point).toEqual(rowCentre(1));
	});

	test("on iOS a button1 identifier means nothing: names decide", async () => {
		const { device, driver } = setup({
			screens: [
				snapshotOf([
					el("alert", { label: "T", children: [el("button", { id: "button1", label: "Cancel" }), button("Keep")] }),
				]),
			],
		});
		await device.alert("accept");
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(2));
	});
});

describe("device.alert on a driver that reads one backend", () => {
	function backends(screens: Snapshot[] | (() => Snapshot), extra: Partial<Parameters<typeof fakeDriver>[0]> = {}) {
		const clock = fakeClock();
		const driver = fakeDriver({ screens, alertBackends: ["ax", "axbridge"], ...extra });
		const device = createDevice({ session: { out: "/tmp/out" }, driver, env, clock });
		return { driver, device, clock };
	}

	test("no modal: exactly one driver read, on the bridge, and no sleeps", async () => {
		const { device, driver, clock } = backends([snapshotOf([])]);
		expect(await device.alert("dismiss")).toBe(false);
		expect(driver.calls).toEqual([{ method: "alertOn", backend: "axbridge" }]);
		expect(clock.time()).toBe(0);
	});

	test("an alert is answered from the same single read", async () => {
		const { device, driver, clock } = backends([withAlert("Not Now", "Save")]);
		expect(await device.alert("dismiss")).toBe(true);
		expect(driver.callsOf("alertOn")).toHaveLength(1);
		expect(driver.callsOf("alert")).toHaveLength(0);
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(1));
		expect(clock.time()).toBe(0);
	});

	test("a modal whose buttons are not readable yet is looked at again, with sleeps", async () => {
		let reads = 0;
		const { device, driver, clock } = backends([withAlert("Not Now", "Save")], {
			onCall: (c) => (c.method === "alertOn" && reads++ < 2 ? { data: { buttons: [] } } : undefined),
		});
		expect(await device.alert("dismiss")).toBe(true);
		expect(driver.callsOf("alertOn")).toHaveLength(3);
		expect(clock.time()).toBeGreaterThan(0);
		expect(clock.time()).toBeLessThan(1000);
	});

	test("a modal that never shows buttons gives up after a few looks", async () => {
		const { device, driver, clock } = backends([snapshotOf([])], {
			onCall: (c) => (c.method === "alertOn" ? { data: { buttons: [] } } : undefined),
		});
		expect(await device.alert("accept")).toBe(false);
		expect(driver.callsOf("alertOn").length).toBeLessThanOrEqual(5);
		expect(driver.callsOf("tap")).toHaveLength(0);
		expect(clock.time()).toBeLessThan(1500);
	});

	test("a bridge that does not answer (right after a launch) is followed by one host read, not the two-reader read", async () => {
		const { device, driver, clock } = backends([snapshotOf([])], {
			onCall: (c) =>
				c.method === "alertOn" && c.backend === "axbridge" ? failWith("E_APP_NOT_RESPONDING") : undefined,
		});
		expect(await device.alert("dismiss")).toBe(false);
		expect(driver.calls).toEqual([
			{ method: "alertOn", backend: "axbridge" },
			{ method: "alertOn", backend: "ax" },
		]);
		expect(clock.time()).toBe(0);
	});

	test("a sheet the host reader sees is answered even when the bridge does not answer", async () => {
		const { device, driver, clock } = backends([withAlert("Cancel", "Open")], {
			onCall: (c) =>
				c.method === "alertOn" && c.backend === "axbridge" ? failWith("E_APP_NOT_RESPONDING") : undefined,
		});
		expect(await device.alert("accept")).toBe(true);
		expect(driver.callsOf("alert")).toHaveLength(0);
		expect(driver.callsOf("tap")).toHaveLength(1);
		expect(clock.time()).toBe(0);
	});

	test("when both single reads fail the two-reader read answers", async () => {
		const { device, driver, clock } = backends([withAlert("Cancel", "OK")], {
			onCall: (c) => (c.method === "alertOn" ? failWith("E_AX_UNAVAILABLE") : undefined),
		});
		expect(await device.alert("accept")).toBe(true);
		expect(driver.calls.map((c) => c.method).slice(0, 3)).toEqual(["alertOn", "alertOn", "alert"]);
		expect(clock.time()).toBe(0);
	});
});

describe("device.openLink", () => {
	/** an "Open in …?" sheet shows once the fake clock passes `showAt` */
	function delayedSheet(showAt: number) {
		const clock = fakeClock();
		const driver = fakeDriver({
			screens: () => (clock.time() >= showAt ? withAlert("Cancel", "Open") : snapshotOf([])),
		});
		const device = createDevice({ session: { out: "/tmp/out" }, driver, env, clock });
		return { driver, device, clock };
	}

	test("opens the url, then accepts Open when the sheet shows late (5 s)", async () => {
		const { driver, device } = delayedSheet(5000);
		await device.openLink("myapp://x");
		expect(driver.callsOf("app.openUrl")[0]?.url).toBe("myapp://x");
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(2));
	});

	test("presses Open again when the first press was lost", async () => {
		const clock = fakeClock();
		const driver: ReturnType<typeof fakeDriver> = fakeDriver({
			screens: () => (driver.callsOf("tap").length >= 2 ? snapshotOf([]) : withAlert("Cancel", "Open")),
		});
		const device = createDevice({ session: { out: "/tmp/out" }, driver, env, clock });
		await device.openLink("myapp://x");
		expect(driver.callsOf("tap")).toHaveLength(2);
	});

	test("stops pressing after 3 attempts", async () => {
		const clock = fakeClock();
		const driver = fakeDriver({ screens: [withAlert("Cancel", "Open")] });
		const device = createDevice({ session: { out: "/tmp/out" }, driver, env, clock });
		await device.openLink("myapp://x");
		expect(driver.callsOf("tap")).toHaveLength(3);
	});

	/** taps on a sheet that stays up, with the fake time of each tap */
	function stubbornSheet(opts: { sheetAt?: number; tapsToDismiss?: number } = {}) {
		const clock = fakeClock();
		const { sheetAt = 0, tapsToDismiss = Number.POSITIVE_INFINITY } = opts;
		const tapTimes: number[] = [];
		const driver: ReturnType<typeof fakeDriver> = fakeDriver({
			screens: () =>
				clock.time() >= sheetAt && tapTimes.length < tapsToDismiss ? withAlert("Cancel", "Open") : snapshotOf([]),
			onCall: (c) => {
				if (c.method === "tap") tapTimes.push(clock.time());
				return undefined;
			},
		});
		const device = createDevice({ session: { out: "/tmp/out" }, driver, env, clock });
		return { device, clock, tapTimes };
	}

	test("gives a sheet that just appeared time to finish animating in before pressing Open", async () => {
		const { device, tapTimes } = stubbornSheet({ sheetAt: 300, tapsToDismiss: 1 });
		await device.openLink("myapp://x");
		expect(tapTimes).toHaveLength(1);
		expect(tapTimes[0]).toBeGreaterThanOrEqual(800);
		expect(tapTimes[0]).toBeLessThanOrEqual(900);
	});

	test("leaves a press time to land before pressing again, and before giving up", async () => {
		const { device, clock, tapTimes } = stubbornSheet();
		await device.openLink("myapp://x");
		expect(tapTimes).toHaveLength(3);
		expect((tapTimes[1] ?? 0) - (tapTimes[0] ?? 0)).toBeGreaterThanOrEqual(600);
		expect((tapTimes[2] ?? 0) - (tapTimes[1] ?? 0)).toBeGreaterThanOrEqual(600);
		expect(clock.time() - (tapTimes[2] ?? 0)).toBeGreaterThanOrEqual(600);
	});

	test("gives up after 8 s without a sheet", async () => {
		const { driver, device, clock } = delayedSheet(20_000);
		await device.openLink("myapp://x");
		expect(driver.callsOf("tap")).toHaveLength(0);
		expect(clock.time()).toBeGreaterThanOrEqual(8000);
		expect(clock.time()).toBeLessThan(8500);
	});

	test("accept:false skips polling", async () => {
		const { driver, device } = delayedSheet(0);
		await device.openLink("myapp://x", { accept: false });
		expect(driver.callsOf("alert")).toHaveLength(0);
		expect(driver.callsOf("tap")).toHaveLength(0);
	});

	test("Android never polls for the sheet", async () => {
		const { driver, device } = setup({ platform: "android", screens: [withAlert("Cancel", "Open")] });
		await device.openLink("myapp://x");
		expect(driver.callsOf("alert")).toHaveLength(0);
	});

	test("leaves an unrelated alert alone", async () => {
		const clock = fakeClock();
		const driver = fakeDriver({ screens: [withAlert("Cancel", "Delete")] });
		const device = createDevice({ session: { out: "/tmp/out" }, driver, env, clock });
		await device.openLink("myapp://x");
		expect(driver.callsOf("tap")).toHaveLength(0);
	});
});

describe("device.openLink without a sheet", () => {
	const APP = env.bundleId;
	const SPRINGBOARD = "com.apple.springboard";

	/** an iOS device whose app is in front from `frontAt`, and whose "Open in …?" sheet (if any) shows from `sheetAt` until a tap */
	function link(
		opts: { frontAt?: number; sheetAt?: number; session?: FixtureSession; clock?: ReturnType<typeof fakeClock> } = {}
	) {
		const clock = opts.clock ?? fakeClock();
		const { frontAt = 0, sheetAt = Number.POSITIVE_INFINITY } = opts;
		const driver: FakeDriver = fakeDriver({
			screens: () =>
				clock.time() >= sheetAt && driver.callsOf("tap").length === 0 ? withAlert("Cancel", "Open") : snapshotOf([]),
			alertBackends: ["ax", "axbridge"],
			frontmost: () => (clock.time() >= frontAt ? APP : SPRINGBOARD),
		});
		const device = createDevice({ session: opts.session ?? { out: "/tmp/out" }, driver, env, clock });
		return { driver, device, clock };
	}

	const reads = (driver: FakeDriver) => driver.callsOf("alert").length + driver.callsOf("alertOn").length;

	test("returns when the quiet window ends once the app is in front and no sheet showed", async () => {
		const { driver, device, clock } = link();
		await device.openLink("myapp://x");
		expect(clock.time()).toBe(1200);
		expect(driver.callsOf("tap")).toHaveLength(0);
	});

	test("polls the cheap host reader first, then confirms with the two-reader read before returning", async () => {
		const { driver, device } = link();
		await device.openLink("myapp://x");
		const methods = driver.calls.map((c) => c.method).filter((m) => m === "alertOn" || m === "alert");
		expect(methods[0]).toBe("alertOn");
		expect(driver.callsOf("alertOn").every((c) => c.backend === "ax")).toBe(true);
		expect(methods[methods.length - 1]).toBe("alert");
	});

	test("polls every 100 ms for the first second, then lines up with the end of the quiet window, then every 250 ms", async () => {
		const { driver, device, clock } = link({ frontAt: 3000 });
		const times: number[] = [];
		const base = driver.alertOn;
		if (base === undefined) throw new Error("fake lacks alertOn");
		driver.alertOn = async (backend) => {
			times.push(clock.time());
			return base(backend);
		};
		const baseFull = driver.alert.bind(driver);
		driver.alert = async () => {
			times.push(clock.time());
			return baseFull();
		};
		await device.openLink("myapp://x");
		expect(times.slice(0, 11)).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
		expect(times.slice(11, 14)).toEqual([1200, 1450, 1700]);
	});

	test("waits for the full window while another app is in front (SpringBoard, Safari)", async () => {
		const { driver, device, clock } = link({ frontAt: 20_000 });
		await device.openLink("myapp://x");
		expect(clock.time()).toBeGreaterThanOrEqual(8000);
		expect(clock.time()).toBeLessThan(8500);
		expect(driver.callsOf("tap")).toHaveLength(0);
	});

	test("a sheet that shows at 3 s is still accepted while another app is in front", async () => {
		const { driver, device, clock } = link({ frontAt: 20_000, sheetAt: 3000 });
		await device.openLink("myapp://x");
		expect(driver.callsOf("tap")).toHaveLength(1);
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(2));
		expect(clock.time()).toBeGreaterThanOrEqual(3000);
		expect(clock.time()).toBeLessThan(4000);
	});

	test("a sheet that shows at 0.5 s is accepted by the cheap reader and the link returns once it is gone", async () => {
		const { driver, device, clock } = link({ sheetAt: 500 });
		await device.openLink("myapp://x");
		expect(driver.callsOf("tap")).toHaveLength(1);
		expect(clock.time()).toBeLessThan(1500);
	});

	test("a driver that cannot say what is in front keeps the old full wait", async () => {
		const clock = fakeClock();
		const driver = fakeDriver({ screens: [snapshotOf([])] });
		const device = createDevice({ session: { out: "/tmp/out" }, driver, env, clock });
		await device.openLink("myapp://x");
		expect(clock.time()).toBeGreaterThanOrEqual(8000);
	});

	test("an unknown bundle id keeps the old full wait", async () => {
		const clock = fakeClock();
		const driver = fakeDriver({ screens: [snapshotOf([])], frontmost: () => APP });
		const device = createDevice({ session: { out: "/tmp/out" }, driver, env: { ...env, bundleId: "" }, clock });
		await device.openLink("myapp://x");
		expect(clock.time()).toBeGreaterThanOrEqual(8000);
	});

	test("a failing frontmost probe is 'unknown', not an error", async () => {
		const clock = fakeClock();
		const driver = fakeDriver({
			screens: [snapshotOf([])],
			frontmost: () => APP,
			onCall: (c) => (c.method === "isFrontmost" ? failWith("E_UNSUPPORTED") : undefined),
		});
		const device = createDevice({ session: { out: "/tmp/out" }, driver, env, clock });
		await device.openLink("myapp://x");
		expect(clock.time()).toBeGreaterThanOrEqual(8000);
	});

	test("a scheme that opened without a sheet skips alert polling for the rest of the session", async () => {
		const session: FixtureSession = { out: "/tmp/out" };
		const clock = fakeClock();
		const first = link({ session, clock });
		await first.device.openLink("myapp://x");
		expect(reads(first.driver)).toBeGreaterThan(0);

		const before = clock.time();
		const second = link({ session, clock });
		await second.device.openLink("myapp://y/z");
		expect(reads(second.driver)).toBe(0);
		expect(clock.time() - before).toBeLessThan(100);
	});

	test("the memo is per scheme and per session", async () => {
		const session: FixtureSession = { out: "/tmp/out" };
		const clock = fakeClock();
		await link({ session, clock }).device.openLink("myapp://x");

		const otherScheme = link({ session, clock });
		await otherScheme.device.openLink("other://x");
		expect(reads(otherScheme.driver)).toBeGreaterThan(0);

		const otherSession = link({ session: { out: "/tmp/out" }, clock });
		await otherSession.device.openLink("myapp://x");
		expect(reads(otherSession.driver)).toBeGreaterThan(0);
	});

	test("a memoised scheme reads alerts again when the app is not in front after the quiet window", async () => {
		const session: FixtureSession = { out: "/tmp/out" };
		const clock = fakeClock();
		await link({ session, clock }).device.openLink("myapp://x");
		const start = clock.time();
		const again = link({ session, clock, frontAt: start + 3000, sheetAt: start + 2000 });
		await again.device.openLink("myapp://x");
		expect(again.driver.callsOf("tap")).toHaveLength(1);
	});

	test("a link that showed a sheet is not memoised", async () => {
		const session: FixtureSession = { out: "/tmp/out" };
		const clock = fakeClock();
		await link({ session, clock, sheetAt: 0 }).device.openLink("myapp://x");
		const next = link({ session, clock });
		await next.device.openLink("myapp://x");
		expect(reads(next.driver)).toBeGreaterThan(0);
	});

	test("accept:false skips the alert polling and the wait", async () => {
		const { driver, device, clock } = link({ sheetAt: 0 });
		await device.openLink("myapp://x", { accept: false });
		expect(reads(driver)).toBe(0);
		expect(clock.time()).toBe(0);
	});

	test("waitMs shortens the window", async () => {
		const { device, clock } = link({ frontAt: 20_000 });
		await device.openLink("myapp://x", { waitMs: 500 });
		expect(clock.time()).toBeGreaterThanOrEqual(500);
		expect(clock.time()).toBeLessThan(800);
	});

	test("waitMs must be a non-negative number", async () => {
		const { device, driver } = link();
		const error = await device.openLink("myapp://x", { waitMs: -1 }).catch((e: unknown) => e);
		expect((error as E2eError).code).toBe("INVALID_ARGUMENT");
		expect(driver.callsOf("app.openUrl")).toHaveLength(0);
	});
});

describe("device.openLink until", () => {
	/** the target screen shows from `at`; `sheetAt` shows an "Open in …?" sheet over it until a tap */
	function target(opts: { at: number; sheetAt?: number; platform?: Platform }) {
		const clock = fakeClock();
		const platform = opts.platform ?? "ios";
		const { sheetAt = Number.POSITIVE_INFINITY } = opts;
		const driver: FakeDriver = fakeDriver({
			platform,
			screens: () => {
				const specs: ElementSpec[] = [];
				if (clock.time() >= opts.at) specs.push(el("text", { id: "target", label: "Target" }));
				if (clock.time() >= sheetAt && driver.callsOf("tap").length === 0) specs.push(alertOf("Cancel", "Open"));
				return snapshotOf(specs, { platform });
			},
			alertBackends: ["ax", "axbridge"],
			frontmost: () => env.bundleId,
		});
		const device = createDevice({ session: { out: "/tmp/out" }, driver, env: { ...env, platform }, clock });
		const screen = createScreen(testHost(driver));
		return { driver, device, clock, locator: screen.getByTestId("target") };
	}

	test("returns as soon as the locator is visible, long before the no-sheet window ends", async () => {
		const { device, clock, locator } = target({ at: 400 });
		await device.openLink("myapp://x", { until: locator });
		expect(clock.time()).toBeGreaterThanOrEqual(400);
		expect(clock.time()).toBeLessThan(1000);
	});

	test("does not return while a sheet is still up, even when the locator is already visible", async () => {
		const { driver, device, locator } = target({ at: 0, sheetAt: 0 });
		await device.openLink("myapp://x", { until: locator });
		expect(driver.callsOf("tap")).toHaveLength(1);
	});

	test("keeps waiting for the locator after the no-sheet window, up to waitMs, without throwing", async () => {
		const { device, clock, locator } = target({ at: 60_000 });
		await device.openLink("myapp://x", { until: locator, waitMs: 3000 });
		expect(clock.time()).toBeGreaterThanOrEqual(3000);
		expect(clock.time()).toBeLessThan(3300);
	});

	test("waits for a locator that shows after the sheet is answered", async () => {
		const { driver, device, clock, locator } = target({ at: 2000, sheetAt: 300 });
		await device.openLink("myapp://x", { until: locator });
		expect(driver.callsOf("tap")).toHaveLength(1);
		expect(clock.time()).toBeGreaterThanOrEqual(2000);
		expect(clock.time()).toBeLessThan(2500);
	});

	test("works on Android, where there is no sheet to poll for", async () => {
		const { driver, device, clock, locator } = target({ at: 500, platform: "android" });
		await device.openLink("myapp://x", { until: locator });
		expect(driver.callsOf("alert")).toHaveLength(0);
		expect(driver.callsOf("alertOn")).toHaveLength(0);
		expect(clock.time()).toBeGreaterThanOrEqual(500);
		expect(clock.time()).toBeLessThan(900);
	});

	test("accept:false with until reads no alerts and still waits for the locator", async () => {
		const { driver, device, clock, locator } = target({ at: 700 });
		await device.openLink("myapp://x", { until: locator, accept: false });
		expect(driver.callsOf("alert")).toHaveLength(0);
		expect(driver.callsOf("alertOn")).toHaveLength(0);
		expect(clock.time()).toBeGreaterThanOrEqual(700);
		expect(clock.time()).toBeLessThan(1000);
	});

	test("a locator that throws (several matches) counts as not visible yet", async () => {
		const clock = fakeClock();
		const driver: FakeDriver = fakeDriver({
			screens: [snapshotOf([el("text", { id: "dup", label: "A" }), el("text", { id: "dup", label: "B" })])],
			alertBackends: ["ax", "axbridge"],
			frontmost: () => env.bundleId,
		});
		const device = createDevice({ session: { out: "/tmp/out" }, driver, env, clock });
		const locator = createScreen(testHost(driver)).getByTestId("dup");
		await expect(locator.isVisible()).rejects.toBeDefined();
		await device.openLink("myapp://x", { until: locator, waitMs: 500 });
		expect(clock.time()).toBeGreaterThanOrEqual(500);
	});
});

describe('the "Open in …?" sheet under systemAlerts', () => {
	const OPEN_IN = "Open in “Example”?";
	const openInSheet = () => el("alert", { label: OPEN_IN, children: [button("Cancel"), button("Open")] });

	/**
	 * An iOS app in front whose "Open in …?" sheet comes up right after the first alert read of `openLink` (that read
	 * sees nothing) and stays until a button is pressed; Open shows the target screen. The screen's reads answer system
	 * alerts with `device.alert("dismiss")`, as `test.use({ systemAlerts: "dismiss" })` does.
	 */
	function lateSheet() {
		const clock = fakeClock();
		let sheet: "none" | "up" | "opened" | "cancelled" = "none";
		let alertReads = 0;
		const pressed = (point: { y: number }): void => {
			if (sheet === "up") sheet = point.y === rowCentre(2).y ? "opened" : "cancelled";
		};
		// the first read sees nothing; the sheet is up by the next snapshot
		const firstRead = (): { data: null } | undefined => {
			alertReads += 1;
			if (alertReads > 1 || sheet !== "none") return undefined;
			sheet = "up";
			return { data: null };
		};
		const driver: FakeDriver = fakeDriver({
			screens: () => {
				if (sheet === "up") return snapshotOf([openInSheet()], { modal: { pid: 7 } });
				return snapshotOf(sheet === "opened" ? [el("text", { id: "target", label: "Target" })] : []);
			},
			onCall: (call) => {
				if (call.method === "tap") pressed(call.point);
				if (call.method === "alertOn" || call.method === "alert") return firstRead();
				return undefined;
			},
			alertBackends: ["ax", "axbridge"],
			frontmost: () => env.bundleId,
		});
		const session: FixtureSession = { out: "/tmp/out" };
		const device = createDevice({ session, driver, env, clock });
		const host = testHost(driver);
		host.answerSystemAlert = () => device.alert("dismiss");
		const screen = createScreen(host);
		return { driver, device, session, screen, sheetState: () => sheet };
	}

	test("openLink({ until }): the until read leaves the sheet to openLink, which presses Open, and the scheme is not memoised", async () => {
		const { device, session, screen, sheetState } = lateSheet();
		await device.openLink("myapp://x", { until: screen.getByTestId("target") });
		expect(sheetState()).toBe("opened");
		expect(sheetlessFor(session).has("myapp")).toBe(false);
	});

	test('dismiss never presses Cancel on an "Open in …?" sheet: it opens the link the test asked for', async () => {
		const { driver, device } = setup({ screens: [snapshotOf([openInSheet()])] });
		expect(await device.alert("dismiss")).toBe(true);
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(2));
	});

	test("an explicit Cancel is still pressed", async () => {
		const { driver, device } = setup({ screens: [snapshotOf([openInSheet()])] });
		expect(await device.alert({ button: "Cancel" })).toBe(true);
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(1));
	});

	test("dismiss still presses Cancel on other alerts", async () => {
		const { driver, device } = setup({ screens: [withAlert("Cancel", "Open")] });
		expect(await device.alert("dismiss")).toBe(true);
		expect(driver.callsOf("tap")[0]?.point).toEqual(rowCentre(1));
	});
});

describe("hardware and system", () => {
	test("home presses the home button", async () => {
		const { driver, device } = setup();
		await device.home();
		expect(driver.callsOf("pressButton")[0]?.button).toBe("home");
	});

	test("back is the Android back key", async () => {
		const { driver, device } = setup({ platform: "android" });
		await device.back();
		expect(driver.callsOf("pressButton")[0]?.button).toBe("back");
	});

	test("back on iOS is INVALID_ARGUMENT", async () => {
		const { device } = setup();
		const error = await device.back().catch((e: unknown) => e);
		expect((error as E2eError).code).toBe("INVALID_ARGUMENT");
	});

	test("orientation, appearance and clipboard round-trip", async () => {
		const { device } = setup();
		expect(await device.orientation("landscapeLeft")).toBe("landscapeLeft");
		expect(await device.orientation()).toBe("landscapeLeft");
		expect(await device.appearance("dark")).toBe("dark");
		await device.setClipboard("hello");
		expect(await device.clipboard()).toBe("hello");
	});
});

describe("device.hideKeyboard", () => {
	const withKeyboard = snapshotOf([el("textfield", { id: "email" }), el("keyboard")]);

	test("iOS presses Enter when a keyboard is in the snapshot", async () => {
		const { driver, device } = setup({ screens: [withKeyboard] });
		await device.hideKeyboard();
		expect(driver.callsOf("key")[0]?.key).toBe("Enter");
	});

	test("Android presses back when a keyboard is in the snapshot", async () => {
		const { driver, device } = setup({
			platform: "android",
			screens: [snapshotOf([el("keyboard")], { platform: "android" })],
		});
		await device.hideKeyboard();
		expect(driver.callsOf("pressButton")[0]?.button).toBe("back");
	});

	test("is a no-op without a keyboard", async () => {
		const { driver, device } = setup({ screens: [snapshotOf([el("textfield")])] });
		await device.hideKeyboard();
		expect(driver.callsOf("key")).toHaveLength(0);
		expect(driver.callsOf("pressButton")).toHaveLength(0);
	});
});

describe("device.settle", () => {
	test("uses the driver's settle", async () => {
		const { driver, device } = setup();
		expect(await device.settle({ quietMs: 100, timeout: 900 })).toEqual({ quiet: true, waitedMs: 0 });
		expect(driver.callsOf("settle")[0]?.opts).toEqual({ quietMs: 100, timeoutMs: 900 });
	});

	test("returns the detail the driver reported: via, reason, frontmostPid", async () => {
		const driver = fakeDriver({
			screens: [snapshotOf([])],
			onCall: (c) =>
				c.method === "settle"
					? { data: { quiet: false, waitedMs: 8000, via: "stream", reason: "frontmost_mismatch", frontmostPid: 99 } }
					: undefined,
		});
		const device = createDevice({ session: { out: "/tmp/out" }, driver, env });
		expect(await device.settle()).toEqual({
			quiet: false,
			waitedMs: 8000,
			via: "stream",
			reason: "frontmost_mismatch",
			frontmostPid: 99,
		});
	});

	test("the hash-polling fallback says via hash", async () => {
		const clock = fakeClock();
		const driver = fakeDriver({
			screens: [snapshotOf([el("text", { label: "a" })])],
			onCall: (c) => (c.method === "settle" ? failWith("E_UNSUPPORTED") : undefined),
		});
		const device = createDevice({ session: { out: "/tmp/out" }, driver, env, clock });
		expect(await device.settle({ quietMs: 200, timeout: 2000 })).toMatchObject({ quiet: true, via: "hash" });
	});

	test("falls back to snapshot-hash polling on E_UNSUPPORTED", async () => {
		const clock = fakeClock();
		const driver = fakeDriver({
			screens: [snapshotOf([el("text", { label: "a" })])],
			onCall: (c) => (c.method === "settle" ? failWith("E_UNSUPPORTED") : undefined),
		});
		const device = createDevice({ session: { out: "/tmp/out" }, driver, env, clock });
		const outcome = await device.settle({ quietMs: 200, timeout: 2000 });
		expect(outcome.quiet).toBe(true);
		expect(driver.callsOf("snapshot").length).toBeGreaterThanOrEqual(2);
	});

	test("fallback reports not quiet while the screen keeps changing", async () => {
		const clock = fakeClock();
		let n = 0;
		const driver = fakeDriver({
			screens: () => snapshotOf([el("text", { label: `tick ${n++}` })]),
			onCall: (c) => (c.method === "settle" ? failWith("E_UNSUPPORTED") : undefined),
		});
		const device = createDevice({ session: { out: "/tmp/out" }, driver, env, clock });
		const outcome = await device.settle({ quietMs: 200, timeout: 1000 });
		expect(outcome.quiet).toBe(false);
	});

	test("other driver failures throw", async () => {
		const driver = fakeDriver({
			screens: [snapshotOf([])],
			onCall: (c) => (c.method === "settle" ? failWith("E_TIMEOUT") : undefined),
		});
		const device = createDevice({ session: { out: "/tmp/out" }, driver, env });
		const error = await device.settle().catch((e: unknown) => e);
		expect((error as E2eError).code).toBe("TIMEOUT");
	});
});

describe("device.snapshot", () => {
	test("renders a header and one line per element", async () => {
		const { device } = setup({ screens: [snapshotOf([el("button", { label: "Sign in", id: "sign-in" })])] });
		const text = await device.snapshot();
		expect(text.split("\n")[0]).toContain("ios axbridge");
		expect(text).toContain('[button] "Sign in" id=sign-in');
	});

	test("interactiveOnly is passed to the driver and filters", async () => {
		const { device, driver } = setup({
			screens: [snapshotOf([el("text", { label: "plain" }), el("button", { label: "Go" })])],
		});
		const text = await device.snapshot({ interactiveOnly: true });
		expect(driver.callsOf("snapshot")[0]?.opts).toEqual({ interactiveOnly: true });
		expect(text).toContain('"Go"');
		expect(text).not.toContain("plain");
	});
});

describe("device.screenshot", () => {
	function withDir(): { dir: string; driver: FakeDriver; device: ReturnType<typeof createDevice> } {
		const dir = mkdtempSync(join(tmpdir(), "e2e-shot-"));
		const driver = fakeDriver({ screens: [snapshotOf([])] });
		const device = createDevice({ session: { out: dir, attemptDir: dir }, driver, env });
		return { dir, driver, device };
	}

	test("numbers screenshots under <attemptDir>/screenshots", async () => {
		const { dir, driver, device } = withDir();
		expect(await device.screenshot("Home screen")).toBe(join(dir, "screenshots", "001-home-screen.png"));
		expect(await device.screenshot("After tap!")).toBe(join(dir, "screenshots", "002-after-tap.png"));
		expect(driver.callsOf("screenshot").map((c) => c.opts?.path)).toEqual([
			join(dir, "screenshots", "001-home-screen.png"),
			join(dir, "screenshots", "002-after-tap.png"),
		]);
	});

	test("a second device on the same attempt continues the numbering from disk", async () => {
		const { dir, device } = withDir();
		await device.screenshot("a");
		await Bun.write(join(dir, "screenshots", "002-b.png"), "x");
		expect(await device.screenshot("c")).toBe(join(dir, "screenshots", "003-c.png"));
	});

	test("writes the bytes itself when the driver returns a png", async () => {
		const dir = mkdtempSync(join(tmpdir(), "e2e-shot-"));
		const driver = fakeDriver({
			screens: [snapshotOf([])],
			onCall: (c) => (c.method === "screenshot" ? { data: { png: new Uint8Array([1, 2, 3]) } } : undefined),
		});
		const device = createDevice({ session: { out: dir, attemptDir: dir }, driver, env });
		const path = await device.screenshot("raw");
		expect(new Uint8Array(await Bun.file(path).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
	});

	test("records a trace screenshot event", async () => {
		const dir = mkdtempSync(join(tmpdir(), "e2e-shot-"));
		const events: unknown[] = [];
		const driver = fakeDriver({ screens: [snapshotOf([])] });
		const device = createDevice({
			session: { out: dir, attemptDir: dir, trace: { write: (e) => events.push(e) } },
			driver,
			env,
		});
		const path = await device.screenshot("x");
		expect(events).toEqual([expect.objectContaining({ type: "screenshot", label: "x", path })]);
	});
});

describe("device misc", () => {
	test("devtools is undefined without a Metro URL", () => {
		expect(setup().device.devtools).toBeUndefined();
	});

	test("an aborted signal fails calls with TIMEOUT", async () => {
		const controller = new AbortController();
		controller.abort();
		const { device, driver } = setup({ session: { signal: controller.signal } });
		const error = await device.home().catch((e: unknown) => e);
		expect((error as E2eError).code).toBe("TIMEOUT");
		expect(driver.calls).toHaveLength(0);
	});
});
