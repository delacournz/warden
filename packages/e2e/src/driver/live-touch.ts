import { ok } from "@delacour/warden-types/result";
import type { Driver, DriverResult, Point } from "./driver.types";

/**
 * Optional capability next to the frozen `Driver` interface (plan WDN-STRM, STRM-6): a live finger, streamed as it
 * moves instead of a pre-planned `gesture` path. Each call is one input event on the device, sent at once.
 *
 * - Points are the driver's own space, like `tap`: iOS portrait-up points, Android pixels in the current rotation.
 * - `pointer` 0 or 1 (default 0); two pointers down make a two-finger touch.
 * - A move or up on a pointer that is not down, or a down on one that is, is `E_BAD_REQUEST`.
 * - `touchUp` without a point lifts where the finger last was.
 * - `touchCancel` lifts every finger (Android sends `ACTION_CANCEL`, so the app drops the gesture).
 * - A finger with no down/move for 10 s is lifted by the device side, so a lost up never leaves it stuck.
 * - A helper or server that predates the ops answers `E_UNSUPPORTED` `detail.reason: "helper_outdated"`.
 */
export type TouchPointer = 0 | 1;

export type LiveTouch = {
	touchDown(point: Point, pointer?: TouchPointer): DriverResult<void>;
	touchMove(point: Point, pointer?: TouchPointer): DriverResult<void>;
	touchUp(point?: Point, pointer?: TouchPointer): DriverResult<void>;
	touchCancel(): DriverResult<void>;
};

export function canLiveTouch(driver: Driver): driver is Driver & LiveTouch {
	const live = driver as Partial<LiveTouch>;
	return (
		typeof live.touchDown === "function" &&
		typeof live.touchMove === "function" &&
		typeof live.touchUp === "function" &&
		typeof live.touchCancel === "function"
	);
}

export type TouchPhase = "down" | "move" | "up";

/** One live touch call. */
export type TouchOp = { op: TouchPhase; point: Point; pointer: TouchPointer } | { op: "cancel" };

/**
 * How the viewer's picture relates to the driver's space.
 * - `width` / `height`: the picture in viewer points, as displayed.
 * - `scale`: driver units per viewer point (iOS 1; Android the density, points → pixels).
 * - `rotation`: degrees clockwise the driver's space was turned to give the picture (0 when the stream is the
 *   framebuffer as the driver sees it).
 */
export type TouchScreen = { width: number; height: number; scale: number; rotation: 0 | 90 | 180 | 270 };

/** What one viewer input frame means for live touch. */
export type ViewerTouch =
	| { kind: "touch"; ops: TouchOp[] }
	| { kind: "other"; type: string }
	| { kind: "invalid"; reason: string };

const PHASES: ReadonlySet<string> = new Set<TouchPhase>(["down", "move", "up"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);

/** A picture point (viewer points) → the driver's space: clamped, turned back by `rotation`, scaled. */
export function pictureToDriver(x: number, y: number, screen: TouchScreen): Point {
	const px = clamp(x, screen.width);
	const py = clamp(y, screen.height);
	const turned = ((): Point => {
		switch (screen.rotation) {
			case 90:
				return { x: py, y: screen.width - px };
			case 180:
				return { x: screen.width - px, y: screen.height - py };
			case 270:
				return { x: screen.height - py, y: px };
			default:
				return { x: px, y: py };
		}
	})();
	return { x: turned.x * screen.scale, y: turned.y * screen.scale };
}

/**
 * One viewer input frame (the `InputFrame` JSON of the viewer's input socket, `{type:"touch"|"multiTouch", phase,
 * …}` in device points) → the live touch ops it means, so the webview keeps one input model.
 * - `touch`: one op on pointer 0. `id`, `durationMs` and `gesture` are ignored: the finger already moved live.
 * - `multiTouch`: 1-2 touches, pointer by ascending touch id; an `up` lifts pointer 1 before pointer 0.
 * - Any other `type` is `other` (the caller handles keys, home, …); a malformed frame is `invalid`.
 */
export function viewerFrameToTouch(frame: unknown, screen: TouchScreen): ViewerTouch {
	if (!isRecord(frame) || typeof frame.type !== "string") return { kind: "invalid", reason: "a frame needs a type" };
	if (frame.type !== "touch" && frame.type !== "multiTouch") return { kind: "other", type: frame.type };
	const phase = frame.phase;
	if (typeof phase !== "string" || !PHASES.has(phase)) {
		return { kind: "invalid", reason: `phase must be down, move or up, got ${String(phase)}` };
	}
	const op = phase as TouchPhase;
	if (frame.type === "touch") {
		if (!finite(frame.x) || !finite(frame.y)) return { kind: "invalid", reason: "touch needs finite x and y" };
		return { kind: "touch", ops: [{ op, point: pictureToDriver(frame.x, frame.y, screen), pointer: 0 }] };
	}
	const fingers = parseFingers(frame.touches);
	if (typeof fingers === "string") return { kind: "invalid", reason: fingers };
	const ops: TouchOp[] = fingers.map((finger, index) => ({
		op,
		point: pictureToDriver(finger.x, finger.y, screen),
		pointer: index === 0 ? 0 : 1,
	}));
	return { kind: "touch", ops: op === "up" ? ops.reverse() : ops };
}

type Finger = { id: number; x: number; y: number };

/** `multiTouch.touches` → 1-2 fingers by ascending id, or why not. */
function parseFingers(touches: unknown): Finger[] | string {
	if (!Array.isArray(touches) || touches.length < 1 || touches.length > 2) return "multiTouch needs 1 or 2 touches";
	const fingers: Finger[] = [];
	for (const touch of touches) {
		if (!isRecord(touch) || !finite(touch.id) || !finite(touch.x) || !finite(touch.y)) {
			return "each touch needs finite id, x and y";
		}
		fingers.push({ id: touch.id, x: touch.x, y: touch.y });
	}
	if (fingers.length === 2 && fingers[0]?.id === fingers[1]?.id) return "two touches share one id";
	return fingers.sort((a, b) => a.id - b.id);
}

/** Sends `ops` in order; the first failure ends it and is the answer. */
export async function applyTouchOps(live: LiveTouch, ops: readonly TouchOp[]): DriverResult<void> {
	for (const touch of ops) {
		const result =
			touch.op === "cancel"
				? await live.touchCancel()
				: touch.op === "down"
					? await live.touchDown(touch.point, touch.pointer)
					: touch.op === "move"
						? await live.touchMove(touch.point, touch.pointer)
						: await live.touchUp(touch.point, touch.pointer);
		if (!result.success) return result;
	}
	return ok(undefined);
}
