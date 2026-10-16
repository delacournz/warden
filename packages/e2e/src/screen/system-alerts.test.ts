import { describe, expect, test } from "bun:test";
import { createDevice, type Device } from "../device";
import { detectAlert } from "../driver/android/android-alert";
import { el, type FakeDriver, fakeDriver, snapshotOf } from "../driver/driver.testing";
import type { AlertInfo, Snapshot } from "../driver/driver.types";
import type { E2eEnv } from "../env";
import { LocatorAssertions } from "../expect/matchers";
import { createScreen } from "./screen";
import { testHost } from "./screen.testing";

const env: E2eEnv = {
	udid: "UDID",
	platform: "ios",
	bundleId: "com.example.app",
	launchArgs: [],
	out: "/tmp/out",
	timeoutMs: 1000,
	actionTimeoutMs: 1000,
	assertionTimeoutMs: 1000,
	headless: false,
	logTimestamps: false,
};

const app = [el("text", { id: "title", label: "Todos" }), el("button", { id: "add", label: "Add", hittable: true })];

const sheet = (...labels: string[]) =>
	el("alert", { label: "Save Password?", children: labels.map((label) => el("button", { label })) });

/**
 * An iOS screen that shows a "Save Password?" sheet over the app until a button is pressed. `snapshot.modal` is set
 * while it is up, as the helper does.
 */
function sheetOverApp(labels: string[] = ["Save Password", "Not Now"]) {
	let up = true;
	const driver = fakeDriver({
		screens: () => (up ? snapshotOf([...app, sheet(...labels)], { modal: { pid: 7 } }) : snapshotOf(app)),
		onCall: (call) => {
			if (call.method === "tap") up = false;
			return undefined;
		},
	});
	return { driver, isUp: () => up };
}

function wire(driver: FakeDriver, action: "accept" | "dismiss" | "off") {
	const host = testHost(driver, { cache: true });
	const holder: { device?: Device } = {};
	if (action !== "off") {
		host.answerSystemAlert = async () => {
			holder.device ??= createDevice({
				session: { out: "/tmp/out" },
				driver: await host.driver(),
				env: { ...env, platform: driver.platform },
				clock: host.clock,
			});
			return holder.device.alert(action);
		};
	}
	return { host, screen: createScreen(host) };
}

const that = (locator: ReturnType<ReturnType<typeof createScreen>["getByTestId"]>) =>
	new LocatorAssertions(locator, { negate: false });

describe("systemAlerts on an iOS-style screen (snapshot.modal)", () => {
	test("off: the sheet is left alone", async () => {
		const { driver } = sheetOverApp();
		const { screen } = wire(driver, "off");
		expect(await screen.getByTestId("title").isVisible()).toBe(true);
		expect(driver.callsOf("tap")).toHaveLength(0);
		expect(driver.callsOf("alert")).toHaveLength(0);
	});

	test("dismiss: a read that sees the sheet presses Not Now and reads again", async () => {
		const { driver, isUp } = sheetOverApp();
		const { screen } = wire(driver, "dismiss");
		expect(await screen.getByTestId("title").isVisible()).toBe(true);
		expect(isUp()).toBe(false);
		expect(driver.callsOf("tap")).toHaveLength(1);
		expect(driver.callsOf("snapshot")).toHaveLength(2);
	});

	test("accept presses the accept button, dismiss the dismiss one", async () => {
		const accepted = sheetOverApp(["Don't Allow", "Allow"]);
		await wire(accepted.driver, "accept").screen.getByTestId("title").read();
		expect(accepted.driver.callsOf("tap")[0]?.point).toEqual({ x: 195, y: 4 * 50 + 22 });
		const dismissed = sheetOverApp(["Don't Allow", "Allow"]);
		await wire(dismissed.driver, "dismiss").screen.getByTestId("title").read();
		expect(dismissed.driver.callsOf("tap")[0]?.point).toEqual({ x: 195, y: 3 * 50 + 22 });
	});

	test("the read answers about the screen after the sheet is gone", async () => {
		const { driver } = sheetOverApp();
		const { screen } = wire(driver, "dismiss");
		await that(screen.getByTestId("add")).toBeVisible();
		expect(driver.callsOf("snapshot")).toHaveLength(2);
		expect(await screen.getByTestId("add").isVisible()).toBe(true);
		expect(driver.callsOf("snapshot")).toHaveLength(2);
	});

	test("an action is answered the same way before it acts", async () => {
		const { driver } = sheetOverApp();
		const { screen } = wire(driver, "dismiss");
		await screen.getByTestId("add").tap();
		const taps = driver.callsOf("tap");
		expect(taps).toHaveLength(2);
		expect(taps[1]?.point).toEqual({ x: 195, y: 72 });
	});

	test("a screen without a sheet costs nothing: one snapshot, no alert read", async () => {
		const driver = fakeDriver({ screens: [snapshotOf(app)] });
		const { screen } = wire(driver, "dismiss");
		await screen.getByTestId("title").isVisible();
		await screen.getByTestId("title").text();
		expect(driver.calls.map((call) => call.method)).toEqual(["snapshot"]);
	});

	test("a sheet that stays up is answered at most three times per look, then the look is returned as it is", async () => {
		const driver = fakeDriver({
			screens: [snapshotOf([...app, sheet("Save Password", "Not Now")], { modal: { pid: 7 } })],
		});
		const { screen } = wire(driver, "dismiss");
		expect(await screen.getByTestId("title").isVisible()).toBe(true);
		expect(driver.callsOf("tap")).toHaveLength(3);
		expect(driver.callsOf("snapshot")).toHaveLength(4);
	});

	test("a modal with no buttons to press leaves the read as it is", async () => {
		const driver = fakeDriver({ screens: [snapshotOf(app, { modal: { pid: 7 } })] });
		const { screen } = wire(driver, "dismiss");
		expect(await screen.getByTestId("title").isVisible()).toBe(true);
		expect(driver.callsOf("tap")).toHaveLength(0);
		expect(driver.callsOf("snapshot")).toHaveLength(1);
	});

	test("field read-backs never answer a sheet", async () => {
		const driver = fakeDriver({
			screens: () =>
				snapshotOf([el("textfield", { id: "field", label: "Email", value: "a@b.co" })], { modal: { pid: 7 } }),
			onCall: (call) => (call.method === "elementAtPoint" ? { data: null } : undefined),
		});
		const { host, screen } = wire(driver, "dismiss");
		let answered = 0;
		const answer = host.answerSystemAlert;
		host.answerSystemAlert = async () => {
			answered += 1;
			return answer?.() ?? false;
		};
		await screen.getByTestId("field").fill("a@b.co");
		expect(answered).toBe(1);
	});
});

const ANDROID_DIALOG = [
	el("other", {
		children: [
			el("text", { id: "alertTitle", text: "Allow camera?" }),
			el("button", { id: "button1", text: "Allow" }),
			el("button", { id: "button2", text: "Deny" }),
		],
	}),
];

describe("systemAlerts on an Android-style screen (alert read from the dump)", () => {
	function androidDialog() {
		let up = true;
		return Object.assign(
			fakeDriver({
				platform: "android",
				screens: () =>
					snapshotOf(up ? [...ANDROID_DIALOG, ...app] : app, {
						platform: "android",
					}),
				onCall: (call) => {
					if (call.method === "tap") up = false;
					return undefined;
				},
			}),
			{ alertIn: (snapshot: Snapshot): AlertInfo | null => detectAlert(snapshot.flat) }
		);
	}

	test("the dialog is found in the snapshot the read took: answering costs no extra dump", async () => {
		const raw = androidDialog();
		const { screen } = wire(raw, "dismiss");
		expect(await screen.getByTestId("title").isVisible()).toBe(true);
		expect(raw.callsOf("tap")).toHaveLength(1);
		expect(raw.callsOf("alert")).toHaveLength(0);
		expect(raw.callsOf("snapshot")).toHaveLength(2);
	});

	test("without a dialog on screen the read is one dump", async () => {
		const raw = Object.assign(
			fakeDriver({ platform: "android", screens: [snapshotOf(app, { platform: "android" })] }),
			{
				alertIn: (snapshot: Snapshot): AlertInfo | null => detectAlert(snapshot.flat),
			}
		);
		const { screen } = wire(raw, "dismiss");
		await screen.getByTestId("title").isVisible();
		expect(raw.calls.map((call) => call.method)).toEqual(["snapshot"]);
	});
});
