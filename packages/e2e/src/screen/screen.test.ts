import { describe, expect, test } from "bun:test";
import { el, fakeDriver, snapshotOf } from "../driver/driver.testing";
import { E2eError } from "../errors";
import { createScreen, type ScreenSwipeOptions } from "./screen";
import { staticDriver, testHost } from "./screen.testing";

async function failure(promise: Promise<unknown>): Promise<E2eError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof E2eError) return error;
		throw error;
	}
	throw new Error("did not reject");
}

function make(driver = staticDriver([el("button", { id: "ok", label: "OK", placeholder: "p", value: "v" })])) {
	const host = testHost(driver);
	return { driver, host, screen: createScreen(host) };
}

describe("queries", () => {
	test("every getBy* is lazy: no driver call until used", () => {
		const { driver, screen } = make();
		screen.getByTestId("ok");
		screen.getByText("OK");
		screen.getByLabel("OK");
		screen.getByPlaceholder("p");
		screen.getByValue("v");
		screen.getByRole("button", "OK");
		screen.locator("id=ok");
		expect(driver.calls).toEqual([]);
	});

	test("each finds the element", async () => {
		const { screen } = make();
		for (const locator of [
			screen.getByTestId("ok"),
			screen.getByText("OK"),
			screen.getByLabel("OK"),
			screen.getByPlaceholder("p"),
			screen.getByValue("v"),
			screen.getByRole("button", "OK"),
			screen.getByRole("button", { name: "OK" }),
			screen.locator("id=ok"),
		]) {
			expect(await locator.count()).toBe(1);
		}
	});

	test("options flow through", async () => {
		const { screen } = make();
		expect(await screen.getByText("ok", { exact: false }).count()).toBe(1);
		expect(await screen.getByText("ok").count()).toBe(0);
		expect(await screen.getByRole("button", "OK", { disabled: true }).count()).toBe(0);
	});

	test("bad queries fail with INVALID_LOCATOR before touching the device", () => {
		const { driver, screen } = make();
		// @ts-expect-error not an option
		expect(() => screen.getByText("x", { nam: 1 })).toThrow(E2eError);
		expect(() => screen.locator("nope")).toThrow(E2eError);
		expect(driver.calls).toEqual([]);
	});
});

describe("tapAt", () => {
	test("taps the point, reported as a step", async () => {
		const { driver, host, screen } = make();
		await screen.tapAt({ x: 10, y: 20 });
		expect(driver.callsOf("tap")).toEqual([{ method: "tap", point: { x: 10, y: 20 } }]);
		expect(host.steps).toEqual(["tapAt (10, 20)"]);
	});

	test("a non-finite point is INVALID_ARGUMENT", async () => {
		const { screen } = make();
		expect((await failure(screen.tapAt({ x: Number.NaN, y: 1 }))).code).toBe("INVALID_ARGUMENT");
	});
});

describe("swipe", () => {
	test("a direction swipes the middle of the screen, content direction", async () => {
		const { driver, screen } = make();
		await screen.swipe({ direction: "down" });
		expect(driver.callsOf("swipe")).toEqual([
			{ method: "swipe", from: { x: 195, y: 633 }, to: { x: 195, y: 211 }, opts: { durationMs: 350, momentum: false } },
		]);
	});

	test("momentum chooses a fling", async () => {
		const { driver, screen } = make();
		await screen.swipe({ direction: "up", momentum: "fast" });
		expect(driver.callsOf("swipe")[0]?.opts).toEqual({ durationMs: 120, momentum: true });
	});

	test("a path swipes exactly from to", async () => {
		const { driver, screen } = make();
		await screen.swipe({ from: { x: 300, y: 50 }, to: { x: 20, y: 50 }, durationMs: 250 });
		expect(driver.callsOf("swipe")).toEqual([
			{ method: "swipe", from: { x: 300, y: 50 }, to: { x: 20, y: 50 }, opts: { durationMs: 250 } },
		]);
	});

	test("mixing the two shapes, or none, is INVALID_ARGUMENT", async () => {
		const { driver, screen } = make();
		const bad = (options: object) => failure(screen.swipe(options as ScreenSwipeOptions));
		expect((await bad({ direction: "up", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } })).code).toBe("INVALID_ARGUMENT");
		expect((await bad({})).code).toBe("INVALID_ARGUMENT");
		expect((await bad({ direction: "up", timeout: 5 })).code).toBe("INVALID_ARGUMENT");
		expect(driver.callsOf("swipe")).toEqual([]);
	});

	test("a driver failure is ACTION_FAILED", async () => {
		const driver = fakeDriver({
			screens: [snapshotOf([])],
			onCall: (call) =>
				call.method === "swipe" ? { error: { code: "E_HID", message: "x", retryable: false } } : undefined,
		});
		const { screen } = make(driver);
		expect((await failure(screen.swipe({ direction: "down" }))).code).toBe("ACTION_FAILED");
	});
});

describe("scrollUntilVisible", () => {
	/** A list whose target is `distance` swipes away: it comes on screen after that many swipes. */
	function feed(distance: number) {
		let swipes = 0;
		const driver = fakeDriver({
			screens: () =>
				snapshotOf([
					el("button", { id: "target", frame: { x: 0, y: swipes >= distance ? 400 : 5000, width: 390, height: 44 } }),
				]),
			onCall: (call) => {
				if (call.method === "swipe") swipes += 1;
				return undefined;
			},
		});
		return { driver, swipes: () => swipes };
	}

	test("returns at once when the target is already on screen", async () => {
		const { driver } = feed(0);
		const { screen } = make(driver);
		await screen.scrollUntilVisible(screen.getByTestId("target"));
		expect(driver.callsOf("swipe")).toEqual([]);
	});

	test("swipes down (content direction) until it shows, settling after each swipe", async () => {
		const { driver, swipes } = feed(3);
		const { screen } = make(driver);
		await screen.scrollUntilVisible(screen.getByTestId("target"));
		expect(swipes()).toBe(3);
		expect(driver.callsOf("settle")).toHaveLength(3);
		const first = driver.callsOf("swipe")[0];
		expect(first && first.from.y > first.to.y).toBe(true);
	});

	test("direction and momentum are forwarded", async () => {
		const { driver } = feed(1);
		const { screen } = make(driver);
		await screen.scrollUntilVisible(screen.getByTestId("target"), { direction: "up", momentum: "slow" });
		const swipe = driver.callsOf("swipe")[0];
		expect(swipe && swipe.from.y < swipe.to.y).toBe(true);
		expect(swipe?.opts).toEqual({ durationMs: 200, momentum: true });
	});

	test("gives up after maxSwipes (default 10) with LOCATOR_NOT_FOUND when absent", async () => {
		const driver = staticDriver([]);
		const { screen } = make(driver);
		const error = await failure(screen.scrollUntilVisible(screen.getByTestId("target")));
		expect(error.code).toBe("LOCATOR_NOT_FOUND");
		expect(error.message).toContain("10 swipes");
		expect(driver.callsOf("swipe")).toHaveLength(10);
	});

	test("maxSwipes is respected, and an element that never reaches the screen is NOT_ACTIONABLE", async () => {
		const { driver } = feed(99);
		const { screen } = make(driver);
		const error = await failure(screen.scrollUntilVisible(screen.getByTestId("target"), { maxSwipes: 2 }));
		expect(error.code).toBe("NOT_ACTIONABLE");
		expect(driver.callsOf("swipe")).toHaveLength(2);
	});

	test("maxSwipes 0 only looks", async () => {
		const { driver } = feed(1);
		const { screen } = make(driver);
		await failure(screen.scrollUntilVisible(screen.getByTestId("target"), { maxSwipes: 0 }));
		expect(driver.callsOf("swipe")).toEqual([]);
	});

	test("the action timeout also stops it", async () => {
		const { driver } = feed(99);
		const { screen } = make(driver);
		const error = await failure(screen.scrollUntilVisible(screen.getByTestId("target"), { timeout: 0 }));
		expect(error.code).toBe("NOT_ACTIONABLE");
		expect(driver.callsOf("swipe")).toEqual([]);
	});

	test("several matches are ambiguous", async () => {
		const { screen } = make(staticDriver([el("button", { label: "A" }), el("button", { label: "A" })]));
		expect((await failure(screen.scrollUntilVisible(screen.getByText("A")))).code).toBe("LOCATOR_AMBIGUOUS");
	});

	test("bad options are INVALID_ARGUMENT", async () => {
		const { screen } = make();
		const target = screen.getByTestId("ok");
		expect((await failure(screen.scrollUntilVisible(target, { maxSwipes: -1 }))).code).toBe("INVALID_ARGUMENT");
		// @ts-expect-error unknown option
		expect((await failure(screen.scrollUntilVisible(target, { speed: 1 }))).code).toBe("INVALID_ARGUMENT");
	});

	test("is reported as one step", async () => {
		const { driver } = feed(2);
		const host = testHost(driver);
		const screen = createScreen(host);
		await screen.scrollUntilVisible(screen.getByTestId("target"));
		expect(host.steps).toEqual(['scrollUntilVisible getByTestId("target")']);
	});
});

describe("host without optional members", () => {
	test("a bare session-like host works", async () => {
		const driver = staticDriver([el("button", { id: "ok" })]);
		const screen = createScreen({ driver: async () => driver, env: { actionTimeoutMs: 50 } });
		await screen.getByTestId("ok").tap();
		expect(driver.callsOf("tap")).toHaveLength(1);
		const error = await failure(screen.getByTestId("nope").tap());
		expect(error.code).toBe("LOCATOR_NOT_FOUND");
	});
});
