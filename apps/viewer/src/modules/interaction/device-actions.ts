import type { InputFrame } from "../../core/api/device.api.ts";
import { classifyFlick } from "./flick.ts";
import { selectTransport, type Transport } from "./transport.ts";

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

/** The live input socket as the actions see it: whether it is ready, and a frame sender. */
export type LiveInput = {
	ready: () => boolean;
	send: (frame: InputFrame) => Promise<void>;
};

type Point = { x: number; y: number };

function centreOf(touches: FingerTouch[]): Point | null {
	if (touches.length === 0) return null;
	const sum = touches.reduce((acc, t) => ({ x: acc.x + t.x, y: acc.y + t.y }), { x: 0, y: 0 });
	return { x: Math.round(sum.x / touches.length), y: Math.round(sum.y / touches.length) };
}

function isNoInput(e: unknown): boolean {
	return typeof e === "object" && e !== null && "code" in e && e.code === "NO_INPUT";
}

function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

type Options = { device: DeviceApi; onError: (message: string) => void; live?: LiveInput };

/**
 * `DeviceActions` over two paths. With the live socket ready, touches stream as down/move/up
 * frames and two-finger events as multiTouch frames; goHome, shake, location, input, key, openUrl
 * and orientation are frames too. A press keeps the path it started on. Otherwise the HTTP path
 * runs: touch events buffer and nothing is sent until `touchUp`, which becomes `tap`, `longPress`,
 * a `swipe` (a fast flick, see `classifyFlick`) or a `drag`; two-finger events become one pinch at
 * their centre on `multiTouchUp`. Orientation is a no-op over HTTP. A direct action whose live send
 * fails with NO_INPUT falls back to HTTP; any other rejection reports its message to `onError`.
 */
export function createDeviceActions({ device, onError, live }: Options): DeviceActions {
	let press: { start: Point; transport: Transport } | null = null;
	let multiTransport: Transport | null = null;
	const ready = () => live?.ready() ?? false;

	const run = (call: Promise<unknown>) => {
		call.catch((e: unknown) => onError(messageOf(e)));
	};
	const sendLive = (frame: InputFrame, fallback?: () => Promise<unknown>) => {
		if (!live) return;
		live.send(frame).catch((e: unknown) => {
			if (fallback && isNoInput(e)) run(fallback());
			else onError(messageOf(e));
		});
	};
	const direct = (frame: InputFrame, http: () => Promise<unknown>) => {
		if (selectTransport(ready()) === "live") sendLive(frame, http);
		else run(http());
	};

	const releaseHttp = (up: Payload<"touchUp">, start: Point) => {
		if (up.gesture === "tap") return run(device.tap(up.x, up.y));
		if (up.gesture === "long_press") return run(device.longPress(start.x, start.y, up.durationMs));
		const flick = classifyFlick({ from: start, to: up, durationMs: up.durationMs });
		if (flick.kind === "swipe") {
			return run(device.swipe({ ...start, direction: flick.direction, durationMs: up.durationMs }));
		}
		run(device.drag({ fromX: start.x, fromY: start.y, toX: up.x, toY: up.y, durationMs: up.durationMs }));
	};

	const touchUp = (up: Payload<"touchUp">) => {
		const current = press;
		press = null;
		if (current?.transport === "live") {
			return sendLive({ type: "touch", phase: "up", x: up.x, y: up.y, durationMs: up.durationMs, gesture: up.gesture });
		}
		releaseHttp(up, current?.start ?? { x: up.x, y: up.y });
	};

	const multiTouchUp = (p: Payload<"multiTouchUp">) => {
		const transport = multiTransport;
		multiTransport = null;
		if (transport === "live") {
			return sendLive({ type: "multiTouch", phase: "up", touches: p.touches, gesture: p.gesture });
		}
		const centre = centreOf(p.touches);
		if (centre) run(device.pinch(centre.x, centre.y, p.gesture));
	};

	return {
		touchDown: (p) => {
			const transport = selectTransport(ready());
			press = { start: { x: p.x, y: p.y }, transport };
			if (transport === "live") sendLive({ type: "touch", phase: "down", x: p.x, y: p.y });
		},
		touchMove: (p) => {
			if (press?.transport === "live") sendLive({ type: "touch", phase: "move", x: p.x, y: p.y });
		},
		touchUp,
		tap: (p) => run(device.tap(p.x, p.y)),
		doubleTap: (p) => run(device.doubleTap(p.x, p.y)),
		longPress: (p) => run(device.longPress(p.x, p.y, p.durationMs)),
		swipe: (p) => run(device.swipe({ x: p.x, y: p.y, direction: p.direction })),
		pinch: (p) => run(device.pinch(p.x, p.y, p.scale)),
		multiTouchDown: (p) => {
			multiTransport = selectTransport(ready());
			if (multiTransport === "live") sendLive({ type: "multiTouch", phase: "down", touches: p.touches });
		},
		multiTouchMove: (p) => {
			if (multiTransport === "live") sendLive({ type: "multiTouch", phase: "move", touches: p.touches });
		},
		multiTouchUp,
		goHome: () => direct({ type: "goHome" }, () => device.goHome()),
		shake: () => direct({ type: "shake" }, () => device.shake()),
		setOrientation: (p) => {
			if (selectTransport(ready()) === "live") sendLive({ type: "orientation", orientation: p.orientation });
		},
		openUrl: (p) => direct({ type: "openUrl", url: p.url }, () => device.openUrl(p.url)),
		setLocation: (p) =>
			direct({ type: "location", latitude: p.latitude, longitude: p.longitude }, () =>
				device.setLocation(p.latitude, p.longitude)
			),
		screenshot: () => run(device.screenshot()),
		inputText: (p) =>
			direct({ type: "input", text: p.text, clearFirst: p.clearFirst, paste: p.paste }, () =>
				device.input(p.text, p.clearFirst)
			),
		key: (p) => direct({ type: "key", key: p.key }, () => device.key(p.key)),
	};
}
