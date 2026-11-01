import { classifyFlick } from "./flick.ts";

/**
 * Device actions for the interaction layer. `createDeviceActions` maps them onto the device API
 * (HTTP commands through Rust); `logActions` only logs, for tests and previews. The rest of the
 * layer depends on the `DeviceActions` type only.
 * Coordinates are DEVICE POINTS (iOS points, e.g. 440x956), not picture pixels.
 */

export type SwipeDirection = "up" | "down" | "left" | "right";
export type PinchScale = "zoom_in" | "zoom_out";
export type TouchGesture = "tap" | "drag" | "long_press";
export type Orientation = "portrait" | "landscape";
export type DeviceKey = "ENTER" | "BACKSPACE";
export type FingerTouch = { id: number; x: number; y: number };

export type DeviceAction =
	| { kind: "touchDown"; x: number; y: number }
	| { kind: "touchMove"; x: number; y: number }
	| { kind: "touchUp"; x: number; y: number; durationMs: number; gesture: TouchGesture }
	| { kind: "tap"; x: number; y: number }
	| { kind: "doubleTap"; x: number; y: number }
	| { kind: "longPress"; x: number; y: number; durationMs?: number }
	| { kind: "swipe"; x: number; y: number; direction: SwipeDirection }
	| { kind: "pinch"; x: number; y: number; scale: PinchScale }
	| { kind: "multiTouchDown"; touches: FingerTouch[] }
	| { kind: "multiTouchMove"; touches: FingerTouch[] }
	| { kind: "multiTouchUp"; touches: FingerTouch[]; gesture: PinchScale }
	| { kind: "goHome" }
	| { kind: "shake" }
	| { kind: "setOrientation"; orientation: Orientation }
	| { kind: "openUrl"; url: string }
	| { kind: "setLocation"; latitude: number; longitude: number }
	| { kind: "screenshot" }
	| { kind: "inputText"; text: string; paste?: boolean; clearFirst?: boolean }
	| { kind: "key"; key: DeviceKey };

type Payload<K extends DeviceAction["kind"]> = Omit<Extract<DeviceAction, { kind: K }>, "kind">;

/** One method per action, taking the payload without its `kind`. */
export type DeviceActions = { [K in DeviceAction["kind"]]: (payload: Payload<K>) => void };

export const DEVICE_ACTION_KINDS = [
	"touchDown",
	"touchMove",
	"touchUp",
	"tap",
	"doubleTap",
	"longPress",
	"swipe",
	"pinch",
	"multiTouchDown",
	"multiTouchMove",
	"multiTouchUp",
	"goHome",
	"shake",
	"setOrientation",
	"openUrl",
	"setLocation",
	"screenshot",
	"inputText",
	"key",
] as const satisfies readonly DeviceAction["kind"][];

/** Build a `DeviceActions` whose every method calls `handle` with the tagged action. */
export function createActions(handle: (action: DeviceAction) => void): DeviceActions {
	const entries = DEVICE_ACTION_KINDS.map((kind) => [
		kind,
		(payload: object) => handle({ kind, ...payload } as DeviceAction),
	]);
	return Object.fromEntries(entries) as DeviceActions;
}

export const logActions: DeviceActions = createActions((action) => {
	const { kind, ...payload } = action;
	console.log("[interaction]", kind, payload);
});

/** The slice of `core/api/device.api.ts` that the actions call; tests pass a fake. */
export type DeviceApi = {
	tap: (x: number, y: number) => Promise<void>;
	doubleTap: (x: number, y: number) => Promise<void>;
	longPress: (x: number, y: number, durationMs?: number) => Promise<void>;
	swipe: (args: { x: number; y: number; direction: SwipeDirection; durationMs?: number }) => Promise<void>;
	drag: (args: { fromX: number; fromY: number; toX: number; toY: number; durationMs?: number }) => Promise<void>;
	pinch: (x: number, y: number, scale: PinchScale) => Promise<void>;
	key: (key: DeviceKey) => Promise<void>;
	goHome: () => Promise<void>;
	shake: () => Promise<void>;
	setLocation: (latitude: number, longitude: number) => Promise<void>;
	input: (text: string, clearFirst?: boolean) => Promise<void>;
	openUrl: (url: string) => Promise<void>;
	screenshot: () => Promise<unknown>;
};

type Point = { x: number; y: number };

function centreOf(touches: FingerTouch[]): Point | null {
	if (touches.length === 0) return null;
	const sum = touches.reduce((acc, t) => ({ x: acc.x + t.x, y: acc.y + t.y }), { x: 0, y: 0 });
	return { x: Math.round(sum.x / touches.length), y: Math.round(sum.y / touches.length) };
}

/**
 * `DeviceActions` backed by the device API. Raw touch events are buffered: nothing is sent until
 * `touchUp`, which becomes a tap, long press, swipe (a fast flick) or drag from the press point.
 * Two-finger events buffer until `multiTouchUp`, which becomes a pinch at the fingers' centre.
 * Rotate is a no-op until a live input path exists. A rejected call reports its message to
 * `onError`; no action throws.
 */
export function createDeviceActions(options: { device: DeviceApi; onError: (message: string) => void }): DeviceActions {
	const { device, onError } = options;
	let pressStart: Point | null = null;

	const run = (call: Promise<unknown>) => {
		call.catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)));
	};

	const release = (up: Payload<"touchUp">) => {
		const start = pressStart ?? { x: up.x, y: up.y };
		pressStart = null;
		if (up.gesture === "tap") return run(device.tap(up.x, up.y));
		if (up.gesture === "long_press") return run(device.longPress(start.x, start.y, up.durationMs));
		const flick = classifyFlick({ from: start, to: up, durationMs: up.durationMs });
		if (flick.kind === "swipe") {
			return run(device.swipe({ ...start, direction: flick.direction, durationMs: up.durationMs }));
		}
		run(device.drag({ fromX: start.x, fromY: start.y, toX: up.x, toY: up.y, durationMs: up.durationMs }));
	};

	return {
		touchDown: (p) => {
			pressStart = { x: p.x, y: p.y };
		},
		touchMove: () => undefined,
		touchUp: release,
		tap: (p) => run(device.tap(p.x, p.y)),
		doubleTap: (p) => run(device.doubleTap(p.x, p.y)),
		longPress: (p) => run(device.longPress(p.x, p.y, p.durationMs)),
		swipe: (p) => run(device.swipe({ x: p.x, y: p.y, direction: p.direction })),
		pinch: (p) => run(device.pinch(p.x, p.y, p.scale)),
		multiTouchDown: () => undefined,
		multiTouchMove: () => undefined,
		multiTouchUp: (p) => {
			const centre = centreOf(p.touches);
			if (centre) run(device.pinch(centre.x, centre.y, p.gesture));
		},
		goHome: () => run(device.goHome()),
		shake: () => run(device.shake()),
		setOrientation: () => undefined,
		openUrl: (p) => run(device.openUrl(p.url)),
		setLocation: (p) => run(device.setLocation(p.latitude, p.longitude)),
		screenshot: () => run(device.screenshot()),
		inputText: (p) => run(device.input(p.text, p.clearFirst)),
		key: (p) => run(device.key(p.key)),
	};
}
