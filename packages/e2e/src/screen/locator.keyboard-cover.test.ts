import { describe, expect, test } from "bun:test";
import { el, fakeDriver, snapshotOf } from "../driver/driver.testing";
import { createScreen } from "./screen";
import { testHost } from "./screen.testing";

/**
 * A target under the on-screen keyboard cannot be touched (the default `software` mode keeps the keyboard up while a
 * spec types): the locator scrolls it into view when it sits in a scroll container, else dismisses the keyboard.
 */

const KEYBOARD = el("keyboard", { frame: { x: 0, y: 600, width: 400, height: 300 } });
const LOW_BUTTON = { x: 24, y: 700, width: 300, height: 44 };
const HIGH_BUTTON = { x: 24, y: 300, width: 300, height: 44 };

function pageOf(screens: ReturnType<typeof snapshotOf>[], extra: Partial<Parameters<typeof fakeDriver>[0]> = {}) {
	const driver = fakeDriver({ screens, ...extra });
	return { driver, screen: createScreen(testHost(driver)) };
}

describe("a tap under the keyboard", () => {
	test("a target above the keyboard is tapped as before", async () => {
		const { driver, screen } = pageOf([snapshotOf([el("button", { id: "go", frame: HIGH_BUTTON }), KEYBOARD])]);
		await screen.getByTestId("go").tap();
		expect(driver.callsOf("tap")).toHaveLength(1);
		expect(driver.callsOf("swipe")).toHaveLength(0);
		expect(driver.callsOf("dismissKeyboard")).toHaveLength(0);
	});

	test("outside a scroll container the keyboard is dismissed first, then the target is tapped", async () => {
		const covered = snapshotOf([el("button", { id: "go", frame: LOW_BUTTON }), KEYBOARD]);
		const clear = snapshotOf([el("button", { id: "go", frame: LOW_BUTTON })]);
		const { driver, screen } = pageOf([covered, clear], {
			onCall: (call) => {
				if (call.method === "dismissKeyboard") driver.advance();
				return undefined;
			},
		});
		await screen.getByTestId("go").tap();
		const order = driver.calls.map((call) => call.method).filter((m) => m === "dismissKeyboard" || m === "tap");
		expect(order).toEqual(["dismissKeyboard", "tap"]);
		expect(driver.callsOf("key")).toHaveLength(0);
	});

	test("in a scroll view the content is scrolled clear of the keyboard instead of dismissing it", async () => {
		const scrolled = (y: number) =>
			snapshotOf([
				el("scrollview", {
					id: "page",
					frame: { x: 0, y: 50, width: 400, height: 850 },
					children: [el("button", { id: "go", frame: { ...LOW_BUTTON, y } })],
				}),
				KEYBOARD,
			]);
		const { driver, screen } = pageOf([scrolled(700), scrolled(500)], {
			onCall: (call) => {
				if (call.method === "swipe") driver.advance();
				return undefined;
			},
		});
		await screen.getByTestId("go").tap();
		const swipe = driver.callsOf("swipe")[0];
		expect(swipe).toBeDefined();
		expect((swipe?.from.y ?? 0) > (swipe?.to.y ?? 0)).toBe(true);
		expect(driver.callsOf("dismissKeyboard")).toHaveLength(0);
		expect(driver.callsOf("tap")[0]?.point.y).toBe(522);
	});

	test("a long press clears the keyboard the same way", async () => {
		const covered = snapshotOf([el("button", { id: "go", frame: LOW_BUTTON }), KEYBOARD]);
		const clear = snapshotOf([el("button", { id: "go", frame: LOW_BUTTON })]);
		const { driver, screen } = pageOf([covered, clear], {
			onCall: (call) => {
				if (call.method === "dismissKeyboard") driver.advance();
				return undefined;
			},
		});
		await screen.getByTestId("go").longPress();
		expect(driver.callsOf("dismissKeyboard")).toHaveLength(1);
		expect(driver.callsOf("longPress")).toHaveLength(1);
	});

	test("it never loops: a target that stays covered is tapped after one attempt to clear it", async () => {
		const covered = snapshotOf([el("button", { id: "go", frame: LOW_BUTTON }), KEYBOARD]);
		const { driver, screen } = pageOf([covered]);
		await screen.getByTestId("go").tap();
		expect(driver.callsOf("dismissKeyboard")).toHaveLength(1);
		expect(driver.callsOf("tap")).toHaveLength(1);
	});
});
