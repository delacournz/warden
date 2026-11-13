import { describe, expect, test } from "bun:test";
import type { InputFrame } from "../../core/api/device.api.ts";
import { createDeviceActions, type DeviceApi, type LiveInput } from "./device-actions.ts";

type Call = { name: string; args: unknown[] };

function fakeDevice(failWith?: string) {
	const calls: Call[] = [];
	const record =
		(name: string) =>
		(...args: unknown[]) => {
			calls.push({ name, args });
			return failWith ? Promise.reject(new Error(failWith)) : Promise.resolve(undefined);
		};
	const device: DeviceApi = {
		tap: record("tap"),
		doubleTap: record("doubleTap"),
		longPress: record("longPress"),
		swipe: record("swipe"),
		drag: record("drag"),
		pinch: record("pinch"),
		key: record("key"),
		goHome: record("goHome"),
		shake: record("shake"),
		setLocation: record("setLocation"),
		input: record("input"),
		openUrl: record("openUrl"),
		screenshot: record("screenshot"),
	};
	return { device, calls };
}

function setup() {
	const { device, calls } = fakeDevice();
	const errors: string[] = [];
	const actions = createDeviceActions({ device, onError: (m) => errors.push(m) });
	return { actions, calls, errors };
}

describe("createDeviceActions touch buffering", () => {
	test("down and move send nothing", () => {
		const { actions, calls } = setup();
		actions.touchDown({ x: 10, y: 20 });
		actions.touchMove({ x: 30, y: 40 });
		expect(calls).toEqual([]);
	});

	test("tap release sends tap at the release point", () => {
		const { actions, calls } = setup();
		actions.touchDown({ x: 10, y: 20 });
		actions.touchUp({ x: 11, y: 21, durationMs: 80, gesture: "tap" });
		expect(calls).toEqual([{ name: "tap", args: [11, 21] }]);
	});

	test("long press release sends longPress from the press point with the duration", () => {
		const { actions, calls } = setup();
		actions.touchDown({ x: 10, y: 20 });
		actions.touchUp({ x: 12, y: 22, durationMs: 700, gesture: "long_press" });
		expect(calls).toEqual([{ name: "longPress", args: [10, 20, 700] }]);
	});

	test("fast long drag release becomes a swipe", () => {
		const { actions, calls } = setup();
		actions.touchDown({ x: 200, y: 600 });
		actions.touchUp({ x: 200, y: 300, durationMs: 120, gesture: "drag" });
		expect(calls).toEqual([{ name: "swipe", args: [{ x: 200, y: 600, direction: "up", durationMs: 120 }] }]);
	});

	test("slow drag release becomes a drag", () => {
		const { actions, calls } = setup();
		actions.touchDown({ x: 200, y: 600 });
		actions.touchUp({ x: 100, y: 300, durationMs: 900, gesture: "drag" });
		expect(calls).toEqual([{ name: "drag", args: [{ fromX: 200, fromY: 600, toX: 100, toY: 300, durationMs: 900 }] }]);
	});

	test("a second press starts from its own point", () => {
		const { actions, calls } = setup();
		actions.touchDown({ x: 1, y: 1 });
		actions.touchUp({ x: 1, y: 1, durationMs: 50, gesture: "tap" });
		actions.touchDown({ x: 300, y: 300 });
		actions.touchUp({ x: 300, y: 300, durationMs: 600, gesture: "long_press" });
		expect(calls[1]).toEqual({ name: "longPress", args: [300, 300, 600] });
	});
});

describe("createDeviceActions direct and two-finger actions", () => {
	test("pinch at the centre of the touches on multiTouchUp", () => {
		const { actions, calls } = setup();
		const touches = [
			{ id: 1, x: 100, y: 200 },
			{ id: 2, x: 300, y: 400 },
		];
		actions.multiTouchDown({ touches });
		actions.multiTouchMove({ touches });
		expect(calls).toEqual([]);
		actions.multiTouchUp({ touches, gesture: "zoom_in" });
		expect(calls).toEqual([{ name: "pinch", args: [200, 300, "zoom_in"] }]);
	});

	test("direct actions map onto the device api", () => {
		const { actions, calls } = setup();
		actions.tap({ x: 1, y: 2 });
		actions.doubleTap({ x: 3, y: 4 });
		actions.longPress({ x: 5, y: 6 });
		actions.swipe({ x: 7, y: 8, direction: "left" });
		actions.pinch({ x: 9, y: 10, scale: "zoom_out" });
		actions.goHome({});
		actions.shake({});
		actions.setLocation({ latitude: 1.5, longitude: 2.5 });
		actions.openUrl({ url: "https://example.com" });
		actions.screenshot({});
		actions.key({ key: "ENTER" });
		expect(calls.map((c) => c.name)).toEqual([
			"tap",
			"doubleTap",
			"longPress",
			"swipe",
			"pinch",
			"goHome",
			"shake",
			"setLocation",
			"openUrl",
			"screenshot",
			"key",
		]);
		expect(calls[7]?.args).toEqual([1.5, 2.5]);
	});

	test("inputText and paste both call input with clearFirst", () => {
		const { actions, calls } = setup();
		actions.inputText({ text: "hi", clearFirst: true });
		actions.inputText({ text: "pasted", paste: true });
		expect(calls).toEqual([
			{ name: "input", args: ["hi", true] },
			{ name: "input", args: ["pasted", undefined] },
		]);
	});

	test("setOrientation is a no-op", () => {
		const { actions, calls } = setup();
		actions.setOrientation({ orientation: "landscape" });
		expect(calls).toEqual([]);
	});
});

describe("createDeviceActions errors", () => {
	test("a rejected call reports its message", async () => {
		const { device } = fakeDevice("boom");
		const errors: string[] = [];
		const actions = createDeviceActions({ device, onError: (m) => errors.push(m) });
		actions.goHome({});
		await Promise.resolve();
		await Promise.resolve();
		expect(errors).toEqual(["boom"]);
	});
});

describe("createDeviceActions live path", () => {
	function liveSetup(initialReady = true) {
		const { device, calls } = fakeDevice();
		const errors: string[] = [];
		const frames: InputFrame[] = [];
		const state = { ready: initialReady, fail: null as unknown };
		const live: LiveInput = {
			ready: () => state.ready,
			send: (frame) => {
				frames.push(frame);
				return state.fail ? Promise.reject(state.fail) : Promise.resolve();
			},
		};
		const actions = createDeviceActions({ device, onError: (m) => errors.push(m), live });
		return { actions, calls, frames, errors, state };
	}

	test("touch goes live as down, move, up with no http call", () => {
		const { actions, calls, frames } = liveSetup();
		actions.touchDown({ x: 1, y: 2 });
		actions.touchMove({ x: 3, y: 4 });
		actions.touchUp({ x: 5, y: 6, durationMs: 90, gesture: "drag" });
		expect(calls).toEqual([]);
		expect(frames).toEqual([
			{ type: "touch", phase: "down", x: 1, y: 2 },
			{ type: "touch", phase: "move", x: 3, y: 4 },
			{ type: "touch", phase: "up", x: 5, y: 6, durationMs: 90, gesture: "drag" },
		]);
	});

	test("not ready falls back to the buffered http path", () => {
		const { actions, calls, frames } = liveSetup(false);
		actions.touchDown({ x: 10, y: 20 });
		actions.touchUp({ x: 10, y: 20, durationMs: 50, gesture: "tap" });
		expect(frames).toEqual([]);
		expect(calls).toEqual([{ name: "tap", args: [10, 20] }]);
	});

	test("a press keeps its path if the socket drops mid-gesture", () => {
		const { actions, calls, frames, state } = liveSetup();
		actions.touchDown({ x: 1, y: 1 });
		state.ready = false;
		actions.touchMove({ x: 2, y: 2 });
		actions.touchUp({ x: 3, y: 3, durationMs: 50, gesture: "tap" });
		expect(frames.map((f) => (f.type === "touch" ? f.phase : f.type))).toEqual(["down", "move", "up"]);
		expect(calls).toEqual([]);
	});

	test("multiTouch goes live", () => {
		const { actions, frames, calls } = liveSetup();
		const touches = [
			{ id: 1, x: 1, y: 2 },
			{ id: 2, x: 3, y: 4 },
		];
		actions.multiTouchDown({ touches });
		actions.multiTouchMove({ touches });
		actions.multiTouchUp({ touches, gesture: "zoom_out" });
		expect(calls).toEqual([]);
		expect(frames).toEqual([
			{ type: "multiTouch", phase: "down", touches },
			{ type: "multiTouch", phase: "move", touches },
			{ type: "multiTouch", phase: "up", touches, gesture: "zoom_out" },
		]);
	});

	test("direct actions go live when ready", () => {
		const { actions, frames, calls } = liveSetup();
		actions.goHome({});
		actions.shake({});
		actions.openUrl({ url: "https://a.b" });
		actions.setLocation({ latitude: 1, longitude: 2 });
		actions.inputText({ text: "x", clearFirst: true, paste: true });
		actions.key({ key: "BACKSPACE" });
		actions.setOrientation({ orientation: "landscape" });
		expect(calls).toEqual([]);
		expect(frames).toEqual([
			{ type: "goHome" },
			{ type: "shake" },
			{ type: "openUrl", url: "https://a.b" },
			{ type: "location", latitude: 1, longitude: 2 },
			{ type: "input", text: "x", clearFirst: true, paste: true },
			{ type: "key", key: "BACKSPACE" },
			{ type: "orientation", orientation: "landscape" },
		]);
	});

	test("direct actions use http when not ready, orientation is a no-op", () => {
		const { actions, frames, calls } = liveSetup(false);
		actions.goHome({});
		actions.setOrientation({ orientation: "landscape" });
		expect(frames).toEqual([]);
		expect(calls).toEqual([{ name: "goHome", args: [] }]);
	});

	test("NO_INPUT from a live send falls back to http", async () => {
		const { actions, calls, state, errors } = liveSetup();
		state.fail = Object.assign(new Error("not connected"), { code: "NO_INPUT" });
		actions.shake({});
		await Promise.resolve();
		await Promise.resolve();
		expect(calls).toEqual([{ name: "shake", args: [] }]);
		expect(errors).toEqual([]);
	});

	test("other live send errors are reported", async () => {
		const { actions, state, errors } = liveSetup();
		state.fail = new Error("boom");
		actions.goHome({});
		await Promise.resolve();
		await Promise.resolve();
		expect(errors).toEqual(["boom"]);
	});
});
