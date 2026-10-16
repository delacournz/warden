import { describe, expect, test } from "bun:test";
import {
	clearKeyPresses,
	contentPath,
	fieldContent,
	fieldValue,
	focusPoint,
	isOnScreen,
	swipeVector,
	tapPointOf,
	visibleRect,
} from "./actions";
import { el, snap } from "./element.testing";
import { indexSnapshot, type NodeEntry } from "./nodes";

function entryOf(element: ReturnType<typeof el>, platform: "ios" | "android" = "ios"): NodeEntry {
	const entry = indexSnapshot(snap([element], { platform })).entries[0];
	if (entry === undefined) throw new Error("no entry");
	return entry;
}

describe("tapPointOf", () => {
	test("centre of the frame by default", () => {
		const entry = entryOf(el("button", { frame: { x: 10, y: 20, width: 100, height: 50 } }));
		expect(tapPointOf(entry)).toEqual({ x: 60, y: 45 });
	});

	test("the driver's tapPoint wins", () => {
		const entry = entryOf(el("button", { frame: { x: 0, y: 0, width: 100, height: 50 }, tapPoint: { x: 3, y: 4 } }));
		expect(tapPointOf(entry)).toEqual({ x: 3, y: 4 });
	});

	test("position is an offset from the top-left corner", () => {
		const entry = entryOf(el("image", { frame: { x: 10, y: 20, width: 100, height: 50 }, tapPoint: { x: 3, y: 4 } }));
		expect(tapPointOf(entry, { x: 5, y: 7 })).toEqual({ x: 15, y: 27 });
	});
});

describe("focusPoint", () => {
	test("near the right end, vertically centred, so the caret lands after the text", () => {
		expect(focusPoint({ x: 24, y: 200, width: 300, height: 44 })).toEqual({ x: 24 + 300 * 0.9, y: 222 });
	});
});

describe("contentPath", () => {
	const rect = { x: 100, y: 200, width: 200, height: 400 };

	test("names the content's direction: the finger travels the other way", () => {
		expect(contentPath("down", rect, 0.5)).toEqual({ from: { x: 200, y: 500 }, to: { x: 200, y: 300 } });
		expect(contentPath("up", rect, 0.5)).toEqual({ from: { x: 200, y: 300 }, to: { x: 200, y: 500 } });
		expect(contentPath("right", rect, 0.5)).toEqual({ from: { x: 250, y: 400 }, to: { x: 150, y: 400 } });
		expect(contentPath("left", rect, 0.5)).toEqual({ from: { x: 150, y: 400 }, to: { x: 250, y: 400 } });
	});

	test("the fraction scales the travel and stays centred", () => {
		expect(contentPath("down", rect, 1)).toEqual({ from: { x: 200, y: 600 }, to: { x: 200, y: 200 } });
	});

	test("swipeVector is contentPath plus the momentum options", () => {
		const { from, to } = swipeVector("left", rect, "none");
		expect({ from, to }).toEqual(contentPath("left", rect, 0.5));
	});
});

describe("swipeVector", () => {
	const rect = { x: 0, y: 0, width: 400, height: 800 };

	test("direction is the way the content scrolls, so the finger goes the other way", () => {
		const down = swipeVector("down", rect);
		expect(down.from.y).toBeGreaterThan(down.to.y);
		expect(down.from.x).toBe(200);
		expect(down.to.x).toBe(200);
		const up = swipeVector("up", rect);
		expect(up.from.y).toBeLessThan(up.to.y);
		const right = swipeVector("right", rect);
		expect(right.from.x).toBeGreaterThan(right.to.x);
		const left = swipeVector("left", rect);
		expect(left.from.x).toBeLessThan(left.to.x);
	});

	test("a plain drag covers half the rect, centred", () => {
		expect(swipeVector("down", rect)).toEqual({
			from: { x: 200, y: 600 },
			to: { x: 200, y: 200 },
			options: { durationMs: 350, momentum: false },
		});
	});

	test("momentum presets", () => {
		expect(swipeVector("down", rect, "slow").options).toEqual({ durationMs: 200, momentum: true });
		const fast = swipeVector("down", rect, "fast");
		expect(fast.options).toEqual({ durationMs: 120, momentum: true });
		expect(fast.from.y - fast.to.y).toBeGreaterThan(400);
	});

	test("stays inside a rect that is offset", () => {
		const vector = swipeVector("left", { x: 100, y: 100, width: 200, height: 100 });
		expect(vector.from.y).toBe(150);
		expect(vector.from.x).toBeGreaterThanOrEqual(100);
		expect(vector.to.x).toBeLessThanOrEqual(300);
	});
});

describe("fieldValue and clearKeyPresses", () => {
	test("the element value, nothing for empty or secure fields", () => {
		expect(fieldValue(entryOf(el("textfield", { value: "me@x.co" })))).toBe("me@x.co");
		expect(fieldValue(entryOf(el("textfield", { value: "" })))).toBe("");
		expect(fieldValue(entryOf(el("securefield", { value: "••••" })))).toBe("");
	});

	test("iOS reports the placeholder as the value of an empty field", () => {
		expect(fieldValue(entryOf(el("textfield", { value: "Email", placeholder: "Email" })))).toBe("");
	});

	test("Android reads the text of an edit field", () => {
		const android = entryOf(el("textfield", { rawType: "android.widget.EditText", text: "typed" }), "android");
		expect(fieldValue(android)).toBe("typed");
	});

	test("one backspace per character plus one spare", () => {
		expect(clearKeyPresses(entryOf(el("textfield", { value: "abc" })))).toBe(4);
		expect(clearKeyPresses(entryOf(el("textfield", { value: "" })))).toBe(0);
		expect(clearKeyPresses(entryOf(el("textfield", { value: "é👍" })))).toBe(3);
	});

	test("secure fields are cleared by the length of their dots", () => {
		expect(clearKeyPresses(entryOf(el("securefield", { value: "••••" })))).toBe(5);
		expect(clearKeyPresses(entryOf(el("securefield")))).toBe(0);
	});

	test("capped", () => {
		expect(clearKeyPresses(entryOf(el("textfield", { value: "x".repeat(2000) })))).toBe(300);
	});

	test("an iOS secure field shows its placeholder as the value: no dots, nothing to press", () => {
		const placeholder = entryOf(el("securefield", { value: "At least 8 characters" }));
		expect(clearKeyPresses(placeholder)).toBe(0);
		expect(fieldContent(placeholder)).toEqual({ kind: "empty" });
	});

	test("secure fields count only bullets, both • and ●", () => {
		expect(clearKeyPresses(entryOf(el("securefield", { value: "●●●" })))).toBe(4);
		expect(clearKeyPresses(entryOf(el("securefield", { value: "•●•" })))).toBe(4);
		expect(clearKeyPresses(entryOf(el("securefield", { value: "Pick one • or more" })))).toBe(2);
	});

	test("a placeholder that the element names is an empty field", () => {
		const entry = entryOf(el("textfield", { value: "Email", placeholder: "Email" }));
		expect(fieldContent(entry)).toEqual({ kind: "empty" });
		expect(clearKeyPresses(entry)).toBe(0);
	});
});

describe("fieldContent", () => {
	test("text, dots or empty", () => {
		expect(fieldContent(entryOf(el("textfield", { value: "me@x.co" })))).toEqual({ kind: "text", text: "me@x.co" });
		expect(fieldContent(entryOf(el("textfield", { value: "" })))).toEqual({ kind: "empty" });
		expect(fieldContent(entryOf(el("securefield", { value: "••••" })))).toEqual({ kind: "dots", count: 4 });
		expect(fieldContent(entryOf(el("securefield")))).toEqual({ kind: "empty" });
	});

	test("a field the driver reports as plain text with a placeholder-looking value is text (iOS sends placeholder: null)", () => {
		expect(fieldContent(entryOf(el("textfield", { value: "ada@example.com" })))).toEqual({
			kind: "text",
			text: "ada@example.com",
		});
	});
});

describe("isOnScreen", () => {
	const screen = { width: 390, height: 844, scale: 3 };
	test("inside, edge and outside", () => {
		expect(isOnScreen({ x: 10, y: 10 }, screen)).toBe(true);
		expect(isOnScreen({ x: 390, y: 844 }, screen)).toBe(true);
		expect(isOnScreen({ x: -1, y: 10 }, screen)).toBe(false);
		expect(isOnScreen({ x: 10, y: 900 }, screen)).toBe(false);
	});

	test("an unknown screen size accepts everything", () => {
		expect(isOnScreen({ x: 5000, y: 5000 }, { width: 0, height: 0, scale: 1 })).toBe(true);
	});
});

describe("visibleRect", () => {
	const screen = { width: 390, height: 844, scale: 3 };
	test("clips to the screen", () => {
		expect(visibleRect({ x: -10, y: 800, width: 100, height: 200 }, screen)).toEqual({
			x: 0,
			y: 800,
			width: 90,
			height: 44,
		});
	});

	test("keeps a frame that fits and an unknown screen", () => {
		const frame = { x: 1, y: 2, width: 3, height: 4 };
		expect(visibleRect(frame, screen)).toEqual(frame);
		expect(visibleRect(frame, { width: 0, height: 0, scale: 1 })).toEqual(frame);
	});

	test("a frame fully off screen is empty", () => {
		expect(visibleRect({ x: 0, y: 900, width: 10, height: 10 }, screen).height).toBe(0);
	});
});
