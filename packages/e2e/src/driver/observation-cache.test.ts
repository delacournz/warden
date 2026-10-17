import { describe, expect, test } from "bun:test";
import { detectAlert } from "./android/android-alert";
import { el, failWith, fakeDriver, snapshotOf, unwrap } from "./driver.testing";
import type { AlertInfo, Driver, Platform, Snapshot } from "./driver.types";
import {
	cacheObservations,
	canDetectAlerts,
	canObserve,
	type DetectsAlerts,
	OBSERVATION_MAX_AGE_MS,
	type Observes,
} from "./observation-cache";

function clockAt(start = 1000) {
	let time = start;
	return {
		now: () => time,
		advance: (ms: number) => {
			time += ms;
		},
	};
}

function setup(platform: Platform = "ios") {
	const clock = clockAt();
	const raw = fakeDriver({ screens: [snapshotOf([el("text", { id: "a", label: "A" })], { platform })], platform });
	const driver = cacheObservations(raw, { now: clock.now });
	return { raw, driver, clock };
}

const REUSE = { reuse: true };
const FRESH = { reuse: false };

describe("observe", () => {
	test("a second observation inside the age window reuses the first snapshot", async () => {
		const { raw, driver } = setup();
		const first = unwrap(await driver.observe(REUSE));
		const second = unwrap(await driver.observe(REUSE));
		expect(second).toBe(first);
		expect(raw.callsOf("snapshot")).toHaveLength(1);
	});

	test("reuse: false always takes a new snapshot, and that one is what the next reuse sees", async () => {
		const { raw, driver } = setup();
		await driver.observe(REUSE);
		const fresh = unwrap(await driver.observe(FRESH));
		expect(raw.callsOf("snapshot")).toHaveLength(2);
		expect(unwrap(await driver.observe(REUSE))).toBe(fresh);
		expect(raw.callsOf("snapshot")).toHaveLength(2);
	});

	test.each([
		["ios", 150],
		["android", 1000],
	] as const)("%s: a snapshot is reusable until it is %d ms old", async (platform, maxAge) => {
		expect(OBSERVATION_MAX_AGE_MS[platform]).toBe(maxAge);
		const { raw, driver, clock } = setup(platform);
		await driver.observe(REUSE);
		clock.advance(maxAge - 1);
		await driver.observe(REUSE);
		expect(raw.callsOf("snapshot")).toHaveLength(1);
		clock.advance(1);
		await driver.observe(REUSE);
		expect(raw.callsOf("snapshot")).toHaveLength(2);
	});

	test("age counts from when the snapshot arrived, not from when it was asked for", async () => {
		const clock = clockAt();
		const raw = fakeDriver({
			screens: [snapshotOf([], { platform: "android" })],
			platform: "android",
			onCall: (call) => {
				if (call.method === "snapshot") clock.advance(1900);
				return undefined;
			},
		});
		const driver = cacheObservations(raw, { now: clock.now });
		await driver.observe(REUSE);
		await driver.observe(REUSE);
		expect(raw.callsOf("snapshot")).toHaveLength(1);
	});

	test("a failed snapshot is returned and not kept", async () => {
		let fail = true;
		const raw = fakeDriver({
			screens: [snapshotOf([])],
			onCall: (call) => (call.method === "snapshot" && fail ? failWith("E_AX_UNAVAILABLE") : undefined),
		});
		const driver = cacheObservations(raw, { now: clockAt().now });
		const failed = await driver.observe(REUSE);
		expect(failed.success).toBe(false);
		fail = false;
		await driver.observe(REUSE);
		expect(raw.callsOf("snapshot")).toHaveLength(2);
	});

	test("the plain snapshot() always reads the device, and a full one is kept for the next observe", async () => {
		const { raw, driver } = setup();
		const taken = unwrap(await driver.snapshot());
		const last = unwrap(await driver.snapshot());
		expect(raw.callsOf("snapshot")).toHaveLength(2);
		expect(unwrap(await driver.observe(REUSE))).toBe(last);
		expect(raw.callsOf("snapshot")).toHaveLength(2);
		expect(taken).toBeDefined();
	});

	test("a filtered snapshot is never kept: it is not the whole screen", async () => {
		const { raw, driver } = setup();
		await driver.snapshot({ interactiveOnly: true });
		await driver.snapshot({ backend: "ax" });
		await driver.observe(REUSE);
		expect(raw.callsOf("snapshot")).toHaveLength(3);
	});

	test("invalidateObservations drops what is kept", async () => {
		const { raw, driver } = setup();
		await driver.observe(REUSE);
		driver.invalidateObservations();
		await driver.observe(REUSE);
		expect(raw.callsOf("snapshot")).toHaveLength(2);
	});
});

describe("previous", () => {
	test("is the kept snapshot of this generation, whatever its age, and never answers a read", async () => {
		const { raw, driver, clock } = setup();
		const first = unwrap(await driver.observe(FRESH));
		clock.advance(OBSERVATION_MAX_AGE_MS.ios * 10);
		expect(driver.previous?.().snapshot).toBe(first);
		await driver.observe(REUSE);
		expect(raw.callsOf("snapshot")).toHaveLength(2);
	});

	test("an input ends the generation: nothing is previous, and the generation number moves", async () => {
		const { driver } = setup();
		await driver.observe(FRESH);
		const before = driver.previous?.();
		await driver.tap({ x: 1, y: 1 });
		const after = driver.previous?.();
		expect(after?.snapshot).toBeUndefined();
		expect(after?.generation).not.toBe(before?.generation);
	});

	test("says how long ago the last input ended; nothing before the first input", async () => {
		const { driver, clock } = setup();
		expect(driver.previous?.().sinceInputMs).toBeUndefined();
		await driver.tap({ x: 1, y: 1 });
		clock.advance(120);
		expect(driver.previous?.().sinceInputMs).toBe(120);
	});

	test("invalidateObservations forgets the snapshot but is not an input", async () => {
		const { driver } = setup();
		await driver.observe(FRESH);
		driver.invalidateObservations();
		expect(driver.previous?.().snapshot).toBeUndefined();
		expect(driver.previous?.().sinceInputMs).toBeUndefined();
	});
});

describe("input generation", () => {
	type Act = [string, (driver: Driver & Observes) => Promise<unknown>];
	const ACTS: Act[] = [
		["tap", (d) => d.tap({ x: 1, y: 1 })],
		["longPress", (d) => d.longPress({ x: 1, y: 1 })],
		["swipe", (d) => d.swipe({ x: 1, y: 1 }, { x: 2, y: 2 })],
		["drag", (d) => d.drag({ x: 1, y: 1 }, { x: 2, y: 2 })],
		["pinch", (d) => d.pinch({ x: 1, y: 1 }, 2)],
		["typeText", (d) => d.typeText("x")],
		["key", (d) => d.key("Enter")],
		["pressButton", (d) => d.pressButton("home")],
		["settle", (d) => d.settle()],
		["orientation(set)", (d) => d.orientation("landscapeLeft")],
		["appearance(set)", (d) => d.appearance("dark")],
		["app.launch", (d) => d.app.launch("com.x")],
		["app.terminate", (d) => d.app.terminate("com.x")],
		["app.openUrl", (d) => d.app.openUrl("x://y")],
		["app.clearData", (d) => d.app.clearData("com.x")],
	];

	test.each(ACTS)("%s makes the next observation a new one", async (_name, act) => {
		const { raw, driver } = setup();
		await driver.observe(REUSE);
		await act(driver);
		await driver.observe(REUSE);
		expect(raw.callsOf("snapshot")).toHaveLength(2);
	});

	test("an optional capability (selectAll) counts as input too", async () => {
		const raw = fakeDriver({ screens: [snapshotOf([])], selectAll: true });
		const driver = cacheObservations(raw, { now: clockAt().now });
		await driver.observe(REUSE);
		await driver.selectAll?.();
		await driver.observe(REUSE);
		expect(raw.callsOf("snapshot")).toHaveLength(2);
	});

	test("an input that fails still drops the kept snapshot", async () => {
		const raw = fakeDriver({
			screens: [snapshotOf([])],
			onCall: (call) => (call.method === "tap" ? failWith("E_HID") : undefined),
		});
		const driver = cacheObservations(raw, { now: clockAt().now });
		await driver.observe(REUSE);
		await driver.tap({ x: 1, y: 1 });
		await driver.observe(REUSE);
		expect(raw.callsOf("snapshot")).toHaveLength(2);
	});

	test("an input that lands while a snapshot is in flight keeps that snapshot out of the cache", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const raw = fakeDriver({ screens: [snapshotOf([])] });
		const slow: Driver = {
			...raw,
			snapshot: async (opts) => {
				await gate;
				return raw.snapshot(opts);
			},
		};
		const driver = cacheObservations(slow, { now: clockAt().now });
		const pending = driver.observe(REUSE);
		await driver.tap({ x: 1, y: 1 });
		release();
		await pending;
		await driver.observe(REUSE);
		expect(raw.callsOf("snapshot")).toHaveLength(2);
	});

	test.each([
		["health", (d: Driver) => d.health()],
		["elementAtPoint", (d: Driver) => d.elementAtPoint({ x: 1, y: 1 })],
		["screenshot", (d: Driver) => d.screenshot()],
		["alert", (d: Driver) => d.alert()],
		["orientation()", (d: Driver) => d.orientation()],
		["appearance()", (d: Driver) => d.appearance()],
		["clipboard()", (d: Driver) => d.clipboard()],
		["app.isRunning", (d: Driver) => d.app.isRunning("com.x")],
		["app.isInstalled", (d: Driver) => d.app.isInstalled("com.x")],
	])("%s is a read: the kept snapshot survives it", async (_name, read) => {
		const { raw, driver } = setup();
		await driver.observe(REUSE);
		await read(driver);
		await driver.observe(REUSE);
		expect(raw.callsOf("snapshot")).toHaveLength(1);
	});

	test("the optional alertOn and isFrontmost reads leave the kept snapshot alone too", async () => {
		const raw = fakeDriver({
			screens: [snapshotOf([])],
			alertBackends: ["ax", "axbridge"],
			frontmost: () => "com.x",
		});
		const driver = cacheObservations(raw, { now: clockAt().now });
		await driver.observe(REUSE);
		await driver.alertOn?.("axbridge");
		await driver.isFrontmost?.("com.x");
		await driver.observe(REUSE);
		expect(raw.callsOf("snapshot")).toHaveLength(1);
	});
});

describe("pass-through", () => {
	test("members read through unchanged, and the wrapper offers the observe capability", () => {
		const { raw, driver } = setup("android");
		expect(driver.platform).toBe("android");
		expect(driver.id).toBe(raw.id);
		expect(driver.capabilities).toBe(raw.capabilities);
		expect(canObserve(driver)).toBe(true);
		expect(canObserve(raw)).toBe(false);
	});

	test("every call reaches the driver with its arguments", async () => {
		const { raw, driver } = setup();
		await driver.tap({ x: 3, y: 4 }, { count: 2 });
		await driver.app.launch("com.x", { relaunch: true });
		expect(raw.callsOf("tap")).toEqual([{ method: "tap", point: { x: 3, y: 4 }, opts: { count: 2 } }]);
		expect(raw.callsOf("app.launch")[0]?.opts).toEqual({ relaunch: true });
	});

	test("an optional capability is still found on the wrapper, and absent ones stay absent", () => {
		const raw = fakeDriver({ screens: [snapshotOf([])], selectAll: true });
		const driver = cacheObservations(raw, { now: clockAt().now });
		expect(typeof driver.selectAll).toBe("function");
		const plain = cacheObservations(fakeDriver({ screens: [snapshotOf([])] }), { now: clockAt().now });
		expect(plain.selectAll).toBeUndefined();
	});
});

const ANDROID_ALERT = snapshotOf(
	[
		el("other", {
			children: [
				el("text", { id: "alertTitle", text: "Allow camera?" }),
				el("button", { id: "button1", text: "Allow" }),
				el("button", { id: "button2", text: "Deny" }),
			],
		}),
	],
	{ platform: "android" }
);

function androidWithAlerts(screen: Snapshot) {
	const clock = clockAt();
	const raw = Object.assign(fakeDriver({ screens: [screen], platform: "android" }), {
		alertIn: (snapshot: Snapshot): AlertInfo | null => detectAlert(snapshot.flat),
	} satisfies DetectsAlerts);
	const driver = cacheObservations(raw, { now: clock.now });
	return { raw, driver, clock };
}

describe("alert on a driver that can read alerts out of a snapshot", () => {
	test("answers from the kept snapshot instead of reading the device again", async () => {
		const { raw, driver } = androidWithAlerts(ANDROID_ALERT);
		await driver.observe(REUSE);
		const info = unwrap(await driver.alert());
		expect(info?.buttons.map((b) => b.identifier)).toEqual(["button1", "button2"]);
		expect(raw.callsOf("snapshot")).toHaveLength(1);
		expect(raw.callsOf("alert")).toHaveLength(0);
	});

	test("with nothing kept it takes one snapshot, which later reads may reuse", async () => {
		const { raw, driver } = androidWithAlerts(snapshotOf([el("text", { label: "Hi" })], { platform: "android" }));
		expect(unwrap(await driver.alert())).toBeNull();
		await driver.observe(REUSE);
		expect(raw.callsOf("snapshot")).toHaveLength(1);
	});

	test("a snapshot already used for an alert read is not served to a second one (a polling loop sees the screen move)", async () => {
		const { raw, driver } = androidWithAlerts(ANDROID_ALERT);
		await driver.observe(REUSE);
		await driver.alert();
		await driver.alert();
		expect(raw.callsOf("snapshot")).toHaveLength(2);
	});

	test("a stale snapshot is not used", async () => {
		const { raw, driver, clock } = androidWithAlerts(ANDROID_ALERT);
		await driver.observe(REUSE);
		clock.advance(OBSERVATION_MAX_AGE_MS.android);
		await driver.alert();
		expect(raw.callsOf("snapshot")).toHaveLength(2);
	});

	test("an input in between sends the alert read to the device", async () => {
		const { raw, driver } = androidWithAlerts(ANDROID_ALERT);
		await driver.observe(REUSE);
		await driver.tap({ x: 1, y: 1 });
		await driver.alert();
		expect(raw.callsOf("snapshot")).toHaveLength(2);
	});

	test("a failed snapshot is the alert read's failure", async () => {
		const raw = Object.assign(
			fakeDriver({
				screens: [ANDROID_ALERT],
				platform: "android",
				onCall: (call) => (call.method === "snapshot" ? failWith("E_AX_UNAVAILABLE") : undefined),
			}),
			{ alertIn: (snapshot: Snapshot) => detectAlert(snapshot.flat) }
		);
		const driver = cacheObservations(raw, { now: clockAt().now });
		const result = await driver.alert();
		expect(!result.success && result.error.code).toBe("E_AX_UNAVAILABLE");
	});

	test("a driver without the capability keeps answering alert() itself", async () => {
		const { raw, driver } = setup();
		expect(canDetectAlerts(raw)).toBe(false);
		await driver.observe(REUSE);
		await driver.alert();
		expect(raw.callsOf("alert")).toHaveLength(1);
		expect(raw.callsOf("snapshot")).toHaveLength(1);
	});
});
