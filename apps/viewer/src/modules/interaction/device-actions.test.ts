import { describe, expect, test } from "bun:test";
import { createDeviceActions, type DeviceApi } from "./device-actions.ts";

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
