import { describe, expect, test } from "bun:test";
import { E2eError } from "@delacour/warden-driver/e2e-error";
import { FakeDriver } from "@delacour/warden-driver/testing/driver";
import { actionGeometry } from "./actions";
import { elementFixtures } from "./element.testing";
import { type NodeEntry, nodeIndexer } from "./nodes";

function entryOf(element: ReturnType<typeof elementFixtures.el>, platform: "ios" | "android" = "ios"): NodeEntry {
	const entry = nodeIndexer.indexSnapshot(elementFixtures.snap([element], { platform })).entries[0];
	if (entry === undefined) throw new Error("no entry");
	return entry;
}

describe("tapPointOf", () => {
	test("centre of the frame by default", () => {
		const entry = entryOf(elementFixtures.el("button", { frame: { x: 10, y: 20, width: 100, height: 50 } }));
		expect(actionGeometry.tapPointOf(entry)).toEqual({ x: 60, y: 45 });
	});

	test("the driver's tapPoint wins", () => {
		const entry = entryOf(
			elementFixtures.el("button", { frame: { x: 0, y: 0, width: 100, height: 50 }, tapPoint: { x: 3, y: 4 } })
		);
		expect(actionGeometry.tapPointOf(entry)).toEqual({ x: 3, y: 4 });
	});

	test("position is an offset from the top-left corner", () => {
		const entry = entryOf(
			elementFixtures.el("image", { frame: { x: 10, y: 20, width: 100, height: 50 }, tapPoint: { x: 3, y: 4 } })
		);
		expect(actionGeometry.tapPointOf(entry, { x: 5, y: 7 })).toEqual({ x: 15, y: 27 });
	});
});

describe("focusPoint", () => {
	test("near the right end, vertically centred, so the caret lands after the text", () => {
		expect(actionGeometry.focusPoint({ x: 24, y: 200, width: 300, height: 44 })).toEqual({ x: 24 + 300 * 0.9, y: 222 });
	});
});

describe("contentPath", () => {
	const rect = { x: 100, y: 200, width: 200, height: 400 };

	test("names the content's direction: the finger travels the other way", () => {
		expect(actionGeometry.contentPath("down", rect, 0.5)).toEqual({ from: { x: 200, y: 500 }, to: { x: 200, y: 300 } });
		expect(actionGeometry.contentPath("up", rect, 0.5)).toEqual({ from: { x: 200, y: 300 }, to: { x: 200, y: 500 } });
		expect(actionGeometry.contentPath("right", rect, 0.5)).toEqual({
			from: { x: 250, y: 400 },
			to: { x: 150, y: 400 },
		});
		expect(actionGeometry.contentPath("left", rect, 0.5)).toEqual({ from: { x: 150, y: 400 }, to: { x: 250, y: 400 } });
	});

	test("the fraction scales the travel and stays centred", () => {
		expect(actionGeometry.contentPath("down", rect, 1)).toEqual({ from: { x: 200, y: 600 }, to: { x: 200, y: 200 } });
	});

	test("swipeVector is contentPath plus the momentum options", () => {
		const { from, to } = actionGeometry.swipeVector("left", rect, "none");
		expect({ from, to }).toEqual(actionGeometry.contentPath("left", rect, 0.5));
	});
});

describe("swipeVector", () => {
	const rect = { x: 0, y: 0, width: 400, height: 800 };

	test("direction is the way the content scrolls, so the finger goes the other way", () => {
		const down = actionGeometry.swipeVector("down", rect);
		expect(down.from.y).toBeGreaterThan(down.to.y);
		expect(down.from.x).toBe(200);
		expect(down.to.x).toBe(200);
		const up = actionGeometry.swipeVector("up", rect);
		expect(up.from.y).toBeLessThan(up.to.y);
		const right = actionGeometry.swipeVector("right", rect);
		expect(right.from.x).toBeGreaterThan(right.to.x);
		const left = actionGeometry.swipeVector("left", rect);
		expect(left.from.x).toBeLessThan(left.to.x);
	});

	test("a plain drag covers half the rect, centred", () => {
		expect(actionGeometry.swipeVector("down", rect)).toEqual({
			from: { x: 200, y: 600 },
			to: { x: 200, y: 200 },
			options: { durationMs: 350, momentum: false },
		});
	});

	test("momentum presets", () => {
		expect(actionGeometry.swipeVector("down", rect, "slow").options).toEqual({ durationMs: 200, momentum: true });
		const fast = actionGeometry.swipeVector("down", rect, "fast");
		expect(fast.options).toEqual({ durationMs: 120, momentum: true });
		expect(fast.from.y - fast.to.y).toBeGreaterThan(400);
	});

	test("stays inside a rect that is offset", () => {
		const vector = actionGeometry.swipeVector("left", { x: 100, y: 100, width: 200, height: 100 });
		expect(vector.from.y).toBe(150);
		expect(vector.from.x).toBeGreaterThanOrEqual(100);
		expect(vector.to.x).toBeLessThanOrEqual(300);
	});
});

describe("fieldValue and clearKeyPresses", () => {
	test("the element value, nothing for empty or secure fields", () => {
		expect(actionGeometry.fieldValue(entryOf(elementFixtures.el("textfield", { value: "me@x.co" })))).toBe("me@x.co");
		expect(actionGeometry.fieldValue(entryOf(elementFixtures.el("textfield", { value: "" })))).toBe("");
		expect(actionGeometry.fieldValue(entryOf(elementFixtures.el("securefield", { value: "••••" })))).toBe("");
	});

	test("iOS reports the placeholder as the value of an empty field", () => {
		expect(
			actionGeometry.fieldValue(entryOf(elementFixtures.el("textfield", { value: "Email", placeholder: "Email" })))
		).toBe("");
	});

	test("Android reads the text of an edit field", () => {
		const android = entryOf(
			elementFixtures.el("textfield", { rawType: "android.widget.EditText", text: "typed" }),
			"android"
		);
		expect(actionGeometry.fieldValue(android)).toBe("typed");
	});

	test("one backspace per character plus one spare", () => {
		expect(actionGeometry.clearKeyPresses(entryOf(elementFixtures.el("textfield", { value: "abc" })))).toBe(4);
		expect(actionGeometry.clearKeyPresses(entryOf(elementFixtures.el("textfield", { value: "" })))).toBe(0);
		expect(actionGeometry.clearKeyPresses(entryOf(elementFixtures.el("textfield", { value: "é👍" })))).toBe(3);
	});

	test("secure fields are cleared by the length of their dots", () => {
		expect(actionGeometry.clearKeyPresses(entryOf(elementFixtures.el("securefield", { value: "••••" })))).toBe(5);
		expect(actionGeometry.clearKeyPresses(entryOf(elementFixtures.el("securefield")))).toBe(0);
	});

	test("capped", () => {
		expect(actionGeometry.clearKeyPresses(entryOf(elementFixtures.el("textfield", { value: "x".repeat(2000) })))).toBe(
			300
		);
	});

	test("an iOS secure field shows its placeholder as the value: no dots, nothing to press", () => {
		const placeholder = entryOf(elementFixtures.el("securefield", { value: "At least 8 characters" }));
		expect(actionGeometry.clearKeyPresses(placeholder)).toBe(0);
		expect(actionGeometry.fieldContent(placeholder)).toEqual({ kind: "empty" });
	});

	test("secure fields count only bullets, both • and ●", () => {
		expect(actionGeometry.clearKeyPresses(entryOf(elementFixtures.el("securefield", { value: "●●●" })))).toBe(4);
		expect(actionGeometry.clearKeyPresses(entryOf(elementFixtures.el("securefield", { value: "•●•" })))).toBe(4);
		expect(
			actionGeometry.clearKeyPresses(entryOf(elementFixtures.el("securefield", { value: "Pick one • or more" })))
		).toBe(2);
	});

	test("a placeholder that the element names is an empty field", () => {
		const entry = entryOf(elementFixtures.el("textfield", { value: "Email", placeholder: "Email" }));
		expect(actionGeometry.fieldContent(entry)).toEqual({ kind: "empty" });
		expect(actionGeometry.clearKeyPresses(entry)).toBe(0);
	});
});

describe("fieldContent", () => {
	test("text, dots or empty", () => {
		expect(actionGeometry.fieldContent(entryOf(elementFixtures.el("textfield", { value: "me@x.co" })))).toEqual({
			kind: "text",
			text: "me@x.co",
		});
		expect(actionGeometry.fieldContent(entryOf(elementFixtures.el("textfield", { value: "" })))).toEqual({
			kind: "empty",
		});
		expect(actionGeometry.fieldContent(entryOf(elementFixtures.el("securefield", { value: "••••" })))).toEqual({
			kind: "dots",
			count: 4,
		});
		expect(actionGeometry.fieldContent(entryOf(elementFixtures.el("securefield")))).toEqual({ kind: "empty" });
	});

	test("a field the driver reports as plain text with a placeholder-looking value is text (iOS sends placeholder: null)", () => {
		expect(actionGeometry.fieldContent(entryOf(elementFixtures.el("textfield", { value: "ada@example.com" })))).toEqual(
			{
				kind: "text",
				text: "ada@example.com",
			}
		);
	});
});

describe("isOnScreen", () => {
	const screen = { width: 390, height: 844, scale: 3 };
	test("inside, edge and outside", () => {
		expect(actionGeometry.isOnScreen({ x: 10, y: 10 }, screen)).toBe(true);
		expect(actionGeometry.isOnScreen({ x: 390, y: 844 }, screen)).toBe(true);
		expect(actionGeometry.isOnScreen({ x: -1, y: 10 }, screen)).toBe(false);
		expect(actionGeometry.isOnScreen({ x: 10, y: 900 }, screen)).toBe(false);
	});

	test("an unknown screen size accepts everything", () => {
		expect(actionGeometry.isOnScreen({ x: 5000, y: 5000 }, { width: 0, height: 0, scale: 1 })).toBe(true);
	});
});

describe("visibleRect", () => {
	const screen = { width: 390, height: 844, scale: 3 };
	test("clips to the screen", () => {
		expect(actionGeometry.visibleRect({ x: -10, y: 800, width: 100, height: 200 }, screen)).toEqual({
			x: 0,
			y: 800,
			width: 90,
			height: 44,
		});
	});

	test("keeps a frame that fits and an unknown screen", () => {
		const frame = { x: 1, y: 2, width: 3, height: 4 };
		expect(actionGeometry.visibleRect(frame, screen)).toEqual(frame);
		expect(actionGeometry.visibleRect(frame, { width: 0, height: 0, scale: 1 })).toEqual(frame);
	});

	test("a frame fully off screen is empty", () => {
		expect(actionGeometry.visibleRect({ x: 0, y: 900, width: 10, height: 10 }, screen).height).toBe(0);
	});
});

describe("gesture geometry", () => {
	const screen = { width: 390, height: 844, scale: 3 };
	const rect = { x: 20, y: 100, width: 350, height: 400 };

	test("centreOf is the middle", () => {
		expect(actionGeometry.centreOf(rect)).toEqual({ x: 195, y: 300 });
	});

	test.each([0.5, 2, 4])("pinchRadius at scale %f keeps both finger ends in the rect and apart", (scale) => {
		const radius = actionGeometry.pinchRadius(rect, scale, screen);
		const widest = radius * Math.max(1, scale);
		expect(widest).toBeLessThanOrEqual((Math.min(rect.width, rect.height) / 2) * 0.8 + 1e-9);
		expect(radius * Math.min(1, scale)).toBeGreaterThanOrEqual(0.04 * 390 - 1e-9);
	});

	test("pinchRadius lets the gap win when the rect is tiny", () => {
		const tiny = { x: 0, y: 0, width: 40, height: 40 };
		expect(actionGeometry.pinchRadius(tiny, 4, screen)).toBeCloseTo(0.04 * 390);
	});

	test("rotateRadius is 30% of the shorter side, clamped", () => {
		expect(actionGeometry.rotateRadius(rect, screen)).toBeCloseTo(105);
		expect(actionGeometry.rotateRadius({ x: 0, y: 0, width: 10, height: 10 }, screen)).toBeCloseTo(0.04 * 390);
		expect(actionGeometry.rotateRadius({ x: 0, y: 0, width: 800, height: 800 }, screen)).toBeCloseTo(0.3 * 390);
	});

	test("requireGesture names the capability and the way out", () => {
		const driver = new FakeDriver({ screens: [], platform: "android", capabilities: { pinch: false, maxPointers: 1 } });
		expect(() => actionGeometry.requireGesture(driver, "pinch", "locator.pinch")).toThrow(
			/locator\.pinch is not supported on android/
		);
		expect(() => actionGeometry.requireGesture(driver, "pinch", "locator.pinch")).toThrow(/test\(\{ platforms/);
		expect(() => actionGeometry.requireGesture(driver, "path", "p", 2)).toThrow(E2eError);
		expect(() => actionGeometry.requireGesture(driver, "path", "p", 1)).not.toThrow();
	});
});
