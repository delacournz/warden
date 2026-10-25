import { describe, expect, test } from "bun:test";
import { el, failWith, fakeDriver, snapshotOf } from "../driver/driver.testing";
import { OBSERVATION_MAX_AGE_MS } from "../driver/observation-cache";
import { LocatorAssertions } from "../expect/matchers";
import { FIELD_POLL_MS, STALE_RISK_READS } from "./field";
import type { Locator } from "./locator";
import { createScreen } from "./screen";
import { staticDriver, testHost } from "./screen.testing";

const expectLocator = (locator: Locator): LocatorAssertions => new LocatorAssertions(locator, { negate: false });

/** Two nodes on a screen that never changes, behind the observation cache and a fake clock. */
function setup(platform: "ios" | "android" = "ios") {
	const driver = staticDriver(
		[
			el("text", { id: "title", label: "Plan" }),
			el("button", { id: "next", label: "Next", hittable: true }),
			el("button", { id: "skip", label: "Skip", hittable: true }),
		],
		platform
	);
	const host = testHost(driver, { cache: true });
	return { driver, host, screen: createScreen(host) };
}

const snapshots = (driver: ReturnType<typeof setup>["driver"]): number => driver.callsOf("snapshot").length;

describe("reads that follow each other", () => {
	test("isVisible then text take one snapshot", async () => {
		const { driver, screen } = setup();
		const title = screen.getByTestId("title");
		expect(await title.isVisible()).toBe(true);
		expect(await title.text()).toBe("Plan");
		expect(snapshots(driver)).toBe(1);
	});

	test("reads of different locators share it too", async () => {
		const { driver, screen } = setup();
		await screen.getByTestId("title").text();
		await screen.getByTestId("next").isVisible();
		await screen.getByTestId("skip").isEnabled();
		expect(snapshots(driver)).toBe(1);
	});

	test("a tap between them makes it three: the tap looks for itself, and so does the read after it", async () => {
		const { driver, screen } = setup();
		const title = screen.getByTestId("title");
		await title.isVisible();
		await screen.getByTestId("next").tap();
		await title.text();
		expect(snapshots(driver)).toBe(3);
	});

	test.each([
		["tapAt", (s: ReturnType<typeof setup>["screen"]) => s.tapAt({ x: 5, y: 5 })],
		["swipe", (s: ReturnType<typeof setup>["screen"]) => s.swipe({ from: { x: 1, y: 1 }, to: { x: 1, y: 9 } })],
		["pinch", (s: ReturnType<typeof setup>["screen"]) => s.gesture.pinch({ scale: 2 })],
		["rotate", (s: ReturnType<typeof setup>["screen"]) => s.gesture.rotate({ degrees: 30 })],
		[
			"gesture",
			(s: ReturnType<typeof setup>["screen"]) =>
				s.gesture.path({
					paths: [
						[
							{ x: 1, y: 1 },
							{ x: 1, y: 9 },
						],
					],
				}),
		],
	])("%s counts as input", async (_name, act) => {
		const { driver, screen } = setup();
		await screen.getByTestId("title").isVisible();
		await act(screen);
		await screen.getByTestId("title").isVisible();
		expect(snapshots(driver)).toBe(2);
	});

	test("a device call that moves the screen (a hardware button) counts as input", async () => {
		const { driver, host, screen } = setup();
		await screen.getByTestId("title").isVisible();
		await (await host.driver()).pressButton("home");
		await screen.getByTestId("title").isVisible();
		expect(snapshots(driver)).toBe(2);
	});

	test.each([
		["ios", 150],
		["android", 1000],
	] as const)("%s: a read that comes %d ms after the last one takes a new snapshot", async (platform, maxAge) => {
		expect(OBSERVATION_MAX_AGE_MS[platform]).toBe(maxAge);
		const { driver, host, screen } = setup(platform);
		const title = screen.getByTestId("title");
		await title.isVisible();
		host.clock.advance(maxAge - 1);
		await title.text();
		expect(snapshots(driver)).toBe(1);
		host.clock.advance(1);
		await title.text();
		expect(snapshots(driver)).toBe(2);
	});

	test("without the cache every read is its own snapshot, as before", async () => {
		const driver = staticDriver([el("text", { id: "title", label: "Plan" })]);
		const screen = createScreen(testHost(driver));
		const title = screen.getByTestId("title");
		await title.isVisible();
		await title.text();
		expect(snapshots(driver)).toBe(2);
	});
});

describe("assertions and actions", () => {
	test("two assertions in a row take one snapshot", async () => {
		const { driver, screen } = setup();
		await expectLocator(screen.getByTestId("title")).toBeVisible();
		await expectLocator(screen.getByTestId("title")).toHaveText("Plan");
		expect(snapshots(driver)).toBe(1);
	});

	test("a tap takes its own look, even right after an assertion saw the element", async () => {
		const { driver, screen } = setup();
		await expectLocator(screen.getByTestId("next")).toBeVisible();
		await screen.getByTestId("next").tap();
		expect(snapshots(driver)).toBe(2);
		expect(driver.callsOf("tap")).toHaveLength(1);
	});

	/** A screen still sliding in when the first snapshot is taken: the button is at y 300 then, and at y 600 once it settles. */
	function slidingIn() {
		let looks = 0;
		const driver = fakeDriver({
			screens: () => {
				looks += 1;
				const y = looks === 1 ? 300 : 600;
				return snapshotOf([
					el("button", { id: "next", label: "Next", hittable: true, frame: { x: 24, y, width: 300, height: 44 } }),
				]);
			},
		});
		return { driver, screen: createScreen(testHost(driver, { cache: true })) };
	}

	test("so the tap lands where the screen has settled, not where an assertion saw it moving", async () => {
		const { driver, screen } = slidingIn();
		await expectLocator(screen.getByTestId("next")).toBeVisible();
		await screen.getByTestId("next").tap();
		expect(driver.callsOf("tap")[0]?.point).toEqual({ x: 174, y: 622 });
	});

	test("longPress aims the same way", async () => {
		const { driver, screen } = slidingIn();
		await expectLocator(screen.getByTestId("next")).toBeVisible();
		await screen.getByTestId("next").longPress();
		expect(driver.callsOf("longPress")[0]?.point).toEqual({ x: 174, y: 622 });
	});

	test("so does a tap at a position inside the element", async () => {
		const { driver, screen } = slidingIn();
		await expectLocator(screen.getByTestId("next")).toBeVisible();
		await screen.getByTestId("next").tap({ position: { x: 1, y: 1 } });
		expect(driver.callsOf("tap")[0]?.point).toEqual({ x: 25, y: 601 });
	});

	test("boundingBox is a new look too: a frame is for aiming", async () => {
		const { screen } = slidingIn();
		await screen.getByTestId("next").isVisible();
		expect((await screen.getByTestId("next").boundingBox()).y).toBe(600);
	});

	test("the assertion after a tap looks at the screen the tap left", async () => {
		const { driver, screen } = setup();
		await screen.getByTestId("next").tap();
		await expectLocator(screen.getByTestId("title")).toBeVisible();
		expect(snapshots(driver)).toBe(2);
	});
});

describe("a settle is a wait, not an input", () => {
	test("an action right after a quiet settle trusts its one look: the app said the input landed", async () => {
		const { driver, host, screen } = setup();
		await screen.tapAt({ x: 1, y: 1 });
		await (await host.driver()).settle();
		await screen.getByTestId("next").tap();
		expect(snapshots(driver)).toBe(1);
	});

	test("a settle that did not report quiet leaves the input recent: the look is checked by one more", async () => {
		const driver = fakeDriver({
			screens: () => snapshotOf([el("button", { id: "next", label: "Next", hittable: true })]),
			onCall: (call) => (call.method === "settle" ? { data: { quiet: false, waitedMs: 3000 } } : undefined),
		});
		const host = testHost(driver, { cache: true });
		const screen = createScreen(host);
		await screen.tapAt({ x: 1, y: 1 });
		await (await host.driver()).settle();
		await screen.getByTestId("next").tap();
		expect(snapshots(driver)).toBe(2);
	});

	test("an assertion after a tap looks at once: the press itself gave the app its time", async () => {
		const { driver, host, screen } = setup();
		await screen.tapAt({ x: 1, y: 1 });
		await expectLocator(screen.getByTestId("title")).toBeVisible();
		expect(host.clock.sleeps).toEqual([]);
		expect(snapshots(driver)).toBe(1);
	});
});

describe("a frame that held still across two looks", () => {
	/** a button whose y is `ys[n]` on the n-th snapshot (the last one sticks), plus an unrelated "menu" button */
	function moving(ys: readonly number[], capabilities: { cheapHitTest?: boolean } = {}) {
		let looks = 0;
		const driver = fakeDriver({
			capabilities,
			screens: () => {
				const y = ys[Math.min(looks, ys.length - 1)] ?? 0;
				looks += 1;
				return snapshotOf([
					el("button", { id: "menu", label: "Menu", hittable: true, frame: { x: 0, y: 40, width: 80, height: 40 } }),
					el("button", { id: "next", label: "Next", hittable: true, frame: { x: 24, y, width: 300, height: 44 } }),
				]);
			},
		});
		const host = testHost(driver, { cache: true });
		return { driver, host, screen: createScreen(host) };
	}

	test("a three-position slide: the tap lands where the button settled, not where it was passing", async () => {
		const { driver, screen } = moving([300, 450, 600]);
		await expectLocator(screen.getByTestId("next")).toBeVisible();
		await screen.getByTestId("next").tap();
		expect(driver.callsOf("tap")[0]?.point).toEqual({ x: 174, y: 622 });
	});

	test("right after an input, with nothing seen since, the first look is checked by a second one", async () => {
		const { driver, screen } = moving([300, 600]);
		await screen.tapAt({ x: 1, y: 1 });
		await screen.getByTestId("next").tap();
		expect(driver.callsOf("tap").at(-1)?.point).toEqual({ x: 174, y: 622 });
		expect(snapshots(driver)).toBe(3);
	});

	test("a tap whose element an assertion of the same generation saw where it still is takes no extra look", async () => {
		const { driver, screen } = moving([600]);
		await screen.tapAt({ x: 1, y: 1 });
		await expectLocator(screen.getByTestId("next")).toBeVisible();
		await screen.getByTestId("next").tap();
		expect(snapshots(driver)).toBe(2);
	});

	test("a look long after the last input, with nothing seen since, is trusted alone", async () => {
		const { driver, host, screen } = moving([600]);
		await screen.tapAt({ x: 1, y: 1 });
		host.clock.advance(300);
		await screen.getByTestId("next").tap();
		expect(snapshots(driver)).toBe(1);
	});

	test("an element that never stops moving is tapped after two extra looks, not waited on", async () => {
		const { driver, screen } = moving([100, 200, 300, 400, 500, 600, 700]);
		await screen.tapAt({ x: 1, y: 1 });
		await screen.getByTestId("next").tap();
		expect(snapshots(driver)).toBe(3);
		expect(driver.callsOf("tap").at(-1)?.point).toEqual({ x: 174, y: 322 });
	});

	test("on a driver with a cheap hit-test, the second look is a hit-test at the element, not a snapshot", async () => {
		const { driver, screen } = moving([600], { cheapHitTest: true });
		await screen.tapAt({ x: 1, y: 1 });
		await screen.getByTestId("next").tap();
		expect(snapshots(driver)).toBe(1);
		expect(driver.callsOf("elementAtPoint")).toHaveLength(1);
		expect(driver.callsOf("tap").at(-1)?.point).toEqual({ x: 174, y: 622 });
	});

	test("a hit-test that does not find the element where the look had it falls back to a full second look", async () => {
		const { driver, screen } = moving([300, 600], { cheapHitTest: true });
		await screen.tapAt({ x: 1, y: 1 });
		await screen.getByTestId("next").tap();
		expect(driver.callsOf("elementAtPoint")).toHaveLength(1);
		expect(snapshots(driver)).toBe(3);
		expect(driver.callsOf("tap").at(-1)?.point).toEqual({ x: 174, y: 622 });
	});

	test("a look that compares with the one before never hit-tests: it already knows whether the frame moved", async () => {
		const { driver, screen } = moving([300, 450, 600], { cheapHitTest: true });
		await expectLocator(screen.getByTestId("next")).toBeVisible();
		await screen.getByTestId("next").tap();
		// the one hit-test is `aimFromKept`'s, on the assertion's snapshot; the comparing looks that follow add none
		expect(driver.callsOf("elementAtPoint")).toHaveLength(1);
		expect(snapshots(driver)).toBe(3);
		expect(driver.callsOf("tap")[0]?.point).toEqual({ x: 174, y: 622 });
	});

	test("with system alerts answered the second look stays a snapshot: a hit-test cannot see an alert outside the app", async () => {
		const { driver, host, screen } = moving([600], { cheapHitTest: true });
		host.answerSystemAlert = async () => false;
		await screen.tapAt({ x: 1, y: 1 });
		await screen.getByTestId("next").tap();
		expect(snapshots(driver)).toBe(2);
		expect(driver.callsOf("elementAtPoint")).toHaveLength(0);
	});

	test("a frame that moves by less than half a point counts as still", async () => {
		const { driver, screen } = moving([600.2, 600.4]);
		await expectLocator(screen.getByTestId("next")).toBeVisible();
		await screen.getByTestId("next").tap();
		expect(snapshots(driver)).toBe(2);
	});
});

describe("only the first poll of a wait may reuse", () => {
	function lateScreen() {
		let shown = false;
		const driver = fakeDriver({
			screens: () => snapshotOf(shown ? [el("text", { id: "late", label: "Late" })] : []),
		});
		const host = testHost(driver, { cache: true });
		const show = () => {
			shown = true;
		};
		return { driver, host, screen: createScreen(host), show };
	}

	test("waitFor: the first poll takes the kept snapshot, the second reads the device", async () => {
		const { driver, host, screen, show } = lateScreen();
		expect(await screen.getByTestId("late").isVisible()).toBe(false);
		show();
		await screen.getByTestId("late").waitFor();
		expect(driver.callsOf("snapshot")).toHaveLength(2);
		expect(host.clock.sleeps).toEqual([100]);
	});

	test("an assertion that is not met on the kept snapshot is met on the next, fresh one", async () => {
		const { driver, screen, show } = lateScreen();
		await screen.getByTestId("late").isVisible();
		show();
		await expectLocator(screen.getByTestId("late")).toBeVisible();
		expect(driver.callsOf("snapshot")).toHaveLength(2);
	});
});

describe("field confirm reads", () => {
	test("never come from the kept snapshot: each one is a read of the device", async () => {
		const driver = fakeDriver({
			screens: () => snapshotOf([el("textfield", { id: "field", label: "Email", value: "a@b.co", focused: true })]),
			onCall: (call) => (call.method === "elementAtPoint" ? { data: null } : undefined),
		});
		const host = testHost(driver, { cache: true });
		await createScreen(host).getByTestId("field").fill("a@b.co");
		const reads = driver.callsOf("elementAtPoint").length;
		expect(reads).toBe(STALE_RISK_READS);
		expect(driver.callsOf("snapshot")).toHaveLength(1 + STALE_RISK_READS);
		expect(host.clock.sleeps.filter((ms) => ms === FIELD_POLL_MS).length).toBe(STALE_RISK_READS - 1);
	});

	test("a hit-test is a driver call of its own, never answered from a snapshot", async () => {
		const driver = fakeDriver({
			screens: () => snapshotOf([el("textfield", { id: "field", label: "Email", value: "" })]),
		});
		const host = testHost(driver, { cache: true });
		await createScreen(host).getByTestId("field").isVisible();
		const seen = await host.driver();
		await seen.elementAtPoint({ x: 10, y: 10 });
		await seen.elementAtPoint({ x: 10, y: 10 });
		expect(driver.callsOf("elementAtPoint")).toHaveLength(2);
	});
});

describe("a failed read", () => {
	test("is not kept: the next read tries the device again", async () => {
		let fail = true;
		const driver = fakeDriver({
			screens: () => snapshotOf([el("text", { id: "title", label: "Plan" })]),
			onCall: (call) => (call.method === "snapshot" && fail ? failWith("E_AX_UNAVAILABLE") : undefined),
		});
		const host = testHost(driver, { cache: true });
		const screen = createScreen(host);
		await expect(screen.getByTestId("title").isVisible()).rejects.toThrow();
		fail = false;
		expect(await screen.getByTestId("title").isVisible()).toBe(true);
	});
});
