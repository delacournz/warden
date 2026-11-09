import { describe, expect, test } from "bun:test";
import { el, fakeDriver, snapshotOf } from "../driver/driver.testing";
import { E2eError } from "../errors";
import { createScreen } from "./screen";
import { testHost } from "./screen.testing";

/**
 * A control drawn over the target (later in the tree: a sticky footer, a tab bar) would take the touch: the locator
 * taps the part of the target nothing covers, scrolls it clear when it is wholly covered in a scroll container, and
 * fails `NOT_ACTIONABLE` naming the cover otherwise. `scrollTo` keeps going until the target is clear of covers.
 */

const FOOTER = el("button", { id: "sign-out", label: "Sign out", frame: { x: 0, y: 760, width: 390, height: 84 } });
const ROW = { x: 20, width: 350, height: 70 };

function page(rowY: number, footer = FOOTER) {
	return snapshotOf([
		el("scrollview", {
			id: "list",
			frame: { x: 0, y: 0, width: 390, height: 844 },
			children: [el("button", { id: "row", label: "Biometrics", frame: { ...ROW, y: rowY } })],
		}),
		footer,
	]);
}

function pageOf(screens: ReturnType<typeof snapshotOf>[], advanceOn: "swipe" | undefined = "swipe") {
	const driver = fakeDriver({
		screens,
		onCall: (call) => {
			if (call.method === advanceOn) driver.advance();
			return undefined;
		},
	});
	return { driver, screen: createScreen(testHost(driver)) };
}

async function failure(promise: Promise<unknown>): Promise<E2eError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof E2eError) return error;
		throw error;
	}
	throw new Error("did not reject");
}

describe("a tap on a covered target", () => {
	test("a target half under a sticky footer is tapped on its uncovered part, not its centre", async () => {
		const { driver, screen } = pageOf([page(740)]);
		await screen.getByTestId("row").tap();
		expect(driver.callsOf("tap")[0]?.point).toEqual({ x: 195, y: 750 });
		expect(driver.callsOf("swipe")).toHaveLength(0);
	});

	test("a target wholly under the footer in a scroll view is scrolled clear first", async () => {
		const { driver, screen } = pageOf([page(770), page(600)]);
		await screen.getByTestId("row").tap();
		const swipe = driver.callsOf("swipe")[0];
		expect(swipe).toBeDefined();
		expect((swipe?.from.y ?? 0) > (swipe?.to.y ?? 0)).toBe(true);
		expect(driver.callsOf("tap")[0]?.point).toEqual({ x: 195, y: 635 });
	});

	test("a covered target that cannot be scrolled is NOT_ACTIONABLE, naming the cover, and nothing is tapped", async () => {
		const covered = snapshotOf([el("button", { id: "row", label: "Row", frame: { ...ROW, y: 770 } }), FOOTER]);
		const { driver, screen } = pageOf([covered]);
		const error = await failure(screen.getByTestId("row").tap({ timeout: 300 }));
		expect(error.code).toBe("NOT_ACTIONABLE");
		expect(error.message).toContain('covered by button "Sign out" (id=sign-out)');
		expect(driver.callsOf("tap")).toHaveLength(0);
	});

	test("an explicit position is the caller's: it is tapped as given", async () => {
		const { driver, screen } = pageOf([page(770)]);
		await screen.getByTestId("row").tap({ position: { x: 10, y: 10 } });
		expect(driver.callsOf("tap")[0]?.point).toEqual({ x: 30, y: 780 });
	});

	test("a long press takes the uncovered part too", async () => {
		const { driver, screen } = pageOf([page(740)]);
		await screen.getByTestId("row").longPress();
		expect(driver.callsOf("longPress")[0]?.point).toEqual({ x: 195, y: 750 });
	});
});

describe("scrollTo and a sticky footer", () => {
	test("a target that reached the screen under the footer is scrolled on until it is clear", async () => {
		const { driver, screen } = pageOf([page(900), page(770), page(600)]);
		await screen.getByTestId("row").scrollTo();
		expect(driver.callsOf("swipe")).toHaveLength(2);
	});
});

describe("scrollTo with no scroll container in the tree (React Native on iOS)", () => {
	test("the drag starts in the free part above the footer, never on it", async () => {
		const flat = (y: number) => snapshotOf([el("button", { id: "row", label: "Row", frame: { ...ROW, y } }), FOOTER]);
		const { driver, screen } = pageOf([flat(755), flat(600)]);
		await screen.getByTestId("row").scrollTo();
		const swipe = driver.callsOf("swipe")[0];
		expect(swipe?.from.y).toBeLessThan(760);
		expect((swipe?.from.y ?? 0) > (swipe?.to.y ?? 0)).toBe(true);
	});
});
