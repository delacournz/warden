/**
 * Stub device actions for the interaction layer. Every action only logs its payload with the
 * `[interaction]` prefix. TODO(wiring agent): replace `logActions` with implementations that call
 * `core/api/device.api.ts`; the rest of the layer depends on the `DeviceActions` type only.
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
	| { kind: "longPress"; x: number; y: number }
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
