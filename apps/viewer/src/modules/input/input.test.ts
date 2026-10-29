import { describe, expect, test } from "bun:test";
import {
	accumulateWheel,
	classifyGesture,
	classifyKey,
	createTextBatcher,
	initialWheelState,
	type PointerSample,
	type Rect,
	toDevicePoint,
} from "./input.ts";

const box: Rect = { left: 0, top: 0, width: 400, height: 400 };

describe("toDevicePoint", () => {
	test("maps a point in a box with the same aspect ratio", () => {
		expect(toDevicePoint(200, 200, box, 1000, 1000)).toEqual({ x: 500, y: 500 });
	});

	test("accounts for pillarbox bars on a tall video", () => {
		// 200x400 video in a 400x400 box: picture spans x 100..300.
		expect(toDevicePoint(100, 0, box, 200, 400)).toEqual({ x: 0, y: 0 });
		expect(toDevicePoint(200, 200, box, 200, 400)).toEqual({ x: 100, y: 200 });
	});

	test("accounts for letterbox bars on a wide video", () => {
		// 400x200 video in a 400x400 box: picture spans y 100..300.
		expect(toDevicePoint(200, 200, box, 400, 200)).toEqual({ x: 200, y: 100 });
	});

	test("returns null inside the bars", () => {
		expect(toDevicePoint(50, 200, box, 200, 400)).toBeNull();
		expect(toDevicePoint(200, 50, box, 400, 200)).toBeNull();
	});

	test("honours the box origin", () => {
		const offset: Rect = { left: 10, top: 20, width: 100, height: 100 };
		expect(toDevicePoint(60, 70, offset, 1000, 1000)).toEqual({ x: 500, y: 500 });
	});

	test("returns null before the video has dimensions", () => {
		expect(toDevicePoint(10, 10, box, 0, 0)).toBeNull();
	});

	test("clamps to the picture edge when asked", () => {
		expect(toDevicePoint(50, 200, box, 200, 400, { clamp: true })).toEqual({ x: 0, y: 200 });
		expect(toDevicePoint(399, 200, box, 200, 400, { clamp: true })).toEqual({ x: 199, y: 200 });
	});
});

describe("classifyGesture", () => {
	const at = (x: number, y: number, t: number): PointerSample => ({ clientX: x, clientY: y, t });

	test("down and up within 8 px is a tap at the release point", () => {
		expect(classifyGesture(at(100, 100, 0), at(104, 103, 90), box, 400, 400)).toEqual({
			kind: "tap",
			x: 104,
			y: 103,
		});
	});

	test("more travel is a swipe whose duration is the elapsed time", () => {
		expect(classifyGesture(at(100, 300, 0), at(100, 100, 250), box, 400, 400)).toEqual({
			kind: "swipe",
			fromX: 100,
			fromY: 300,
			toX: 100,
			toY: 100,
			durationMs: 250,
		});
	});

	test("clamps duration", () => {
		const fast = classifyGesture(at(0, 0, 0), at(300, 0, 5), box, 400, 400);
		const slow = classifyGesture(at(0, 0, 0), at(300, 0, 9000), box, 400, 400);
		expect(fast).toMatchObject({ kind: "swipe", durationMs: 50 });
		expect(slow).toMatchObject({ kind: "swipe", durationMs: 2000 });
	});

	test("a press that starts outside the picture is ignored", () => {
		expect(classifyGesture(at(50, 200, 0), at(200, 200, 100), box, 200, 400)).toBeNull();
	});

	test("a swipe released outside the picture ends on the edge", () => {
		expect(classifyGesture(at(200, 200, 0), at(10, 200, 100), box, 200, 400)).toMatchObject({
			kind: "swipe",
			toX: 0,
		});
	});

	test("scales to device pixels", () => {
		expect(classifyGesture(at(200, 200, 0), at(200, 200, 40), box, 1000, 1000)).toEqual({
			kind: "tap",
			x: 500,
			y: 500,
		});
	});
});

describe("accumulateWheel", () => {
	const wheel = (deltaX: number, deltaY: number, t: number) => ({
		clientX: 200,
		clientY: 200,
		deltaX,
		deltaY,
		t,
	});

	test("emits a swipe on the first event", () => {
		const { swipe } = accumulateWheel(initialWheelState, wheel(0, 100, 1000), box, 400, 400);
		expect(swipe).toEqual({
			kind: "swipe",
			fromX: 200,
			fromY: 200,
			toX: 200,
			toY: 100,
			durationMs: 150,
		});
	});

	test("accumulates events inside the throttle window then flushes them together", () => {
		const first = accumulateWheel(initialWheelState, wheel(0, 40, 1000), box, 400, 400);
		const second = accumulateWheel(first.state, wheel(0, 30, 1050), box, 400, 400);
		expect(second.swipe).toBeNull();
		const third = accumulateWheel(second.state, wheel(0, 20, 1200), box, 400, 400);
		expect(third.swipe).toMatchObject({ fromY: 200, toY: 150 });
		expect(third.state.dx).toBe(0);
		expect(third.state.dy).toBe(0);
	});

	test("ignores a wheel over the bars", () => {
		const { swipe } = accumulateWheel(
			initialWheelState,
			{ clientX: 10, clientY: 200, deltaX: 0, deltaY: 50, t: 1000 },
			box,
			200,
			400
		);
		expect(swipe).toBeNull();
	});
});

describe("classifyKey", () => {
	const key = (k: string, mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) => ({
		key: k,
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		...mods,
	});

	test("printable keys are text", () => {
		expect(classifyKey(key("a"))).toEqual({ kind: "text", text: "a" });
		expect(classifyKey(key(" "))).toEqual({ kind: "text", text: " " });
	});

	test("Enter is a newline", () => {
		expect(classifyKey(key("Enter"))).toEqual({ kind: "newline" });
	});

	test("chords and named keys are not input", () => {
		expect(classifyKey(key("c", { metaKey: true }))).toBeNull();
		expect(classifyKey(key("a", { ctrlKey: true }))).toBeNull();
		expect(classifyKey(key("Shift"))).toBeNull();
		expect(classifyKey(key("ArrowLeft"))).toBeNull();
	});
});

describe("createTextBatcher", () => {
	function harness() {
		const sent: string[] = [];
		let pending: (() => void) | null = null;
		const batcher = createTextBatcher({
			send: (text) => sent.push(text),
			delayMs: 150,
			setTimer: (fn) => {
				pending = fn;
				return 1;
			},
			clearTimer: () => {
				pending = null;
			},
		});
		return { batcher, sent, fire: () => pending?.(), hasTimer: () => pending !== null };
	}

	test("batches keys until the debounce fires", () => {
		const h = harness();
		h.batcher.push("h");
		h.batcher.push("i");
		expect(h.sent).toEqual([]);
		h.fire();
		expect(h.sent).toEqual(["hi"]);
		expect(h.hasTimer()).toBe(false);
	});

	test("flush sends immediately and cancels the timer", () => {
		const h = harness();
		h.batcher.push("a");
		h.batcher.push("\n");
		h.batcher.flush();
		expect(h.sent).toEqual(["a\n"]);
		expect(h.hasTimer()).toBe(false);
	});

	test("flush with nothing buffered sends nothing", () => {
		const h = harness();
		h.batcher.flush();
		expect(h.sent).toEqual([]);
	});

	test("cancel drops the buffer", () => {
		const h = harness();
		h.batcher.push("x");
		h.batcher.cancel();
		h.batcher.flush();
		expect(h.sent).toEqual([]);
	});
});
