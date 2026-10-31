import { describe, expect, test } from "bun:test";
import { el, fakeDriver, snapshotOf } from "../driver/driver.testing";
import { createScreen } from "./screen";
import { testHost } from "./screen.testing";

/**
 * With TalkBack on, a driver that offers `ActsOnElements` takes the action; if it declines (`handled: false`, not in
 * that mode) the touch goes out as before. A raw coordinate tap and a positioned tap are always touches.
 */

const list = el("scrollview", { id: "list", frame: { x: 0, y: 100, width: 400, height: 600 } });
const button = el("button", { id: "go", label: "Go", frame: { x: 24, y: 600, width: 300, height: 44 } });

function setup(handled: boolean | undefined) {
	const driver = fakeDriver({
		screens: [snapshotOf([list, button])],
		...(handled === undefined ? {} : { elementActions: { handled } }),
	});
	return { driver, screen: createScreen(testHost(driver)) };
}

describe("tap through accessibility actions", () => {
	test("a handled press is not also a touch", async () => {
		const { driver, screen } = setup(true);
		await screen.getByTestId("go").tap();
		expect(driver.callsOf("pressElement")).toHaveLength(1);
		expect(driver.callsOf("pressElement")[0]?.element.identifier).toBe("go");
		expect(driver.callsOf("tap")).toHaveLength(0);
	});
	test("a declined press falls back to the touch at the element's centre", async () => {
		const { driver, screen } = setup(false);
		await screen.getByTestId("go").tap();
		expect(driver.callsOf("pressElement")).toHaveLength(1);
		expect(driver.callsOf("tap")[0]?.point).toEqual({ x: 174, y: 622 });
	});
	test("a driver without the capability just taps", async () => {
		const { driver, screen } = setup(undefined);
		await screen.getByTestId("go").tap();
		expect(driver.callsOf("tap")).toHaveLength(1);
	});
	test("a positioned tap and tapAt stay touches", async () => {
		const { driver, screen } = setup(true);
		await screen.getByTestId("go").tap({ position: { x: 2, y: 2 } });
		await screen.tapAt({ x: 5, y: 5 });
		expect(driver.callsOf("pressElement")).toHaveLength(0);
		expect(driver.callsOf("tap")).toHaveLength(2);
	});
});

describe("scroll through accessibility actions", () => {
	test("a locator swipe scrolls that element, no swipe", async () => {
		const { driver, screen } = setup(true);
		await screen.getByTestId("list").swipe({ direction: "down" });
		expect(driver.callsOf("scrollElement")[0]).toMatchObject({ direction: "down", within: { identifier: "list" } });
		expect(driver.callsOf("swipe")).toHaveLength(0);
	});
	test("a screen swipe by direction scrolls the screen's scrollable", async () => {
		const { driver, screen } = setup(true);
		await screen.swipe({ direction: "up" });
		expect(driver.callsOf("scrollElement")[0]).toMatchObject({ direction: "up" });
		expect(driver.callsOf("swipe")).toHaveLength(0);
	});
	test("a declined scroll swipes", async () => {
		const { driver, screen } = setup(false);
		await screen.swipe({ direction: "down" });
		expect(driver.callsOf("swipe")).toHaveLength(1);
	});
	test("a swipe between two points is always a swipe", async () => {
		const { driver, screen } = setup(true);
		await screen.swipe({ from: { x: 1, y: 2 }, to: { x: 3, y: 4 } });
		expect(driver.callsOf("scrollElement")).toHaveLength(0);
		expect(driver.callsOf("swipe")).toHaveLength(1);
	});
});
