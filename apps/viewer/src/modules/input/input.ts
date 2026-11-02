/** Pure input mapping: client coordinates to device pixels, gestures, wheel and keys. */

export type Rect = { left: number; top: number; width: number; height: number };
export type DevicePoint = { x: number; y: number };
export type PointerSample = { clientX: number; clientY: number; t: number };

export type Tap = { kind: "tap"; x: number; y: number };
export type Swipe = {
	kind: "swipe";
	fromX: number;
	fromY: number;
	toX: number;
	toY: number;
	durationMs: number;
};
export type Gesture = Tap | Swipe;

const TAP_SLOP_PX = 8;
const MIN_SWIPE_MS = 50;
const MAX_SWIPE_MS = 2000;
const WHEEL_THROTTLE_MS = 120;
const WHEEL_SWIPE_MS = 150;

/** The rectangle the video picture occupies inside its `object-fit: contain` box. */
function pictureRect(box: Rect, videoWidth: number, videoHeight: number): Rect | null {
	if (videoWidth <= 0 || videoHeight <= 0 || box.width <= 0 || box.height <= 0) return null;
	const scale = Math.min(box.width / videoWidth, box.height / videoHeight);
	const width = videoWidth * scale;
	const height = videoHeight * scale;
	return {
		left: box.left + (box.width - width) / 2,
		top: box.top + (box.height - height) / 2,
		width,
		height,
	};
}

/**
 * Map a client point to integer device pixels. Returns null outside the picture (the letterbox
 * bars), or when `clamp` is set, the nearest point on the picture edge.
 */
export function toDevicePoint(
	clientX: number,
	clientY: number,
	box: Rect,
	videoWidth: number,
	videoHeight: number,
	options: { clamp?: boolean } = {}
): DevicePoint | null {
	const pic = pictureRect(box, videoWidth, videoHeight);
	if (!pic) return null;
	let fx = (clientX - pic.left) / pic.width;
	let fy = (clientY - pic.top) / pic.height;
	if (fx < 0 || fx > 1 || fy < 0 || fy > 1) {
		if (!options.clamp) return null;
		fx = Math.min(1, Math.max(0, fx));
		fy = Math.min(1, Math.max(0, fy));
	}
	return {
		x: Math.min(videoWidth - 1, Math.round(fx * videoWidth)),
		y: Math.min(videoHeight - 1, Math.round(fy * videoHeight)),
	};
}

/**
 * Turn a press/release pair into a tap (travel within 8 client px) or a swipe whose duration is the
 * elapsed time. A press outside the picture yields null; a release outside ends on the edge.
 */
export function classifyGesture(
	down: PointerSample,
	up: PointerSample,
	box: Rect,
	videoWidth: number,
	videoHeight: number
): Gesture | null {
	const from = toDevicePoint(down.clientX, down.clientY, box, videoWidth, videoHeight);
	if (!from) return null;
	const to = toDevicePoint(up.clientX, up.clientY, box, videoWidth, videoHeight, { clamp: true });
	if (!to) return null;
	const travel = Math.hypot(up.clientX - down.clientX, up.clientY - down.clientY);
	if (travel <= TAP_SLOP_PX) return { kind: "tap", x: to.x, y: to.y };
	const durationMs = Math.min(MAX_SWIPE_MS, Math.max(MIN_SWIPE_MS, Math.round(up.t - down.t)));
	return { kind: "swipe", fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, durationMs };
}

export type WheelState = { dx: number; dy: number; lastFlush: number };
export type WheelEventSample = {
	clientX: number;
	clientY: number;
	deltaX: number;
	deltaY: number;
	t: number;
};

export const initialWheelState: WheelState = { dx: 0, dy: 0, lastFlush: Number.NEGATIVE_INFINITY };

/**
 * Accumulate wheel deltas and emit at most one swipe per throttle window, anchored at the cursor.
 * Scrolling down drags the finger up, so the swipe travels against the delta.
 */
export function accumulateWheel(
	state: WheelState,
	event: WheelEventSample,
	box: Rect,
	videoWidth: number,
	videoHeight: number
): { state: WheelState; swipe: Swipe | null } {
	const anchor = toDevicePoint(event.clientX, event.clientY, box, videoWidth, videoHeight);
	if (!anchor) return { state, swipe: null };
	const dx = state.dx + event.deltaX;
	const dy = state.dy + event.deltaY;
	if (event.t - state.lastFlush < WHEEL_THROTTLE_MS || (dx === 0 && dy === 0)) {
		return { state: { ...state, dx, dy }, swipe: null };
	}
	const end = toDevicePoint(event.clientX - dx, event.clientY - dy, box, videoWidth, videoHeight, { clamp: true });
	if (!end) return { state, swipe: null };
	return {
		state: { dx: 0, dy: 0, lastFlush: event.t },
		swipe: {
			kind: "swipe",
			fromX: anchor.x,
			fromY: anchor.y,
			toX: end.x,
			toY: end.y,
			durationMs: WHEEL_SWIPE_MS,
		},
	};
}

export type KeyEventSample = {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
};
export type KeyAction = { kind: "text"; text: string } | { kind: "newline" };

/** Printable keys become text and Enter a newline. Chords and named keys are not input. */
export function classifyKey(event: KeyEventSample): KeyAction | null {
	if (event.ctrlKey || event.metaKey) return null;
	if (event.key === "Enter") return { kind: "newline" };
	if ([...event.key].length === 1) return { kind: "text", text: event.key };
	return null;
}

export type TextBatcher = {
	push: (text: string) => void;
	flush: () => void;
	cancel: () => void;
};

/** Debounced text buffer: keys collect until `delayMs` of quiet, or an explicit flush. */
export function createTextBatcher(options: {
	send: (text: string) => void;
	delayMs: number;
	setTimer: (fn: () => void, ms: number) => unknown;
	clearTimer: (handle: unknown) => void;
}): TextBatcher {
	let buffer = "";
	let handle: unknown = null;

	const clear = () => {
		if (handle !== null) options.clearTimer(handle);
		handle = null;
	};
	const flush = () => {
		clear();
		if (buffer === "") return;
		const text = buffer;
		buffer = "";
		options.send(text);
	};
	return {
		push(text) {
			buffer += text;
			clear();
			handle = options.setTimer(flush, options.delayMs);
		},
		flush,
		cancel() {
			clear();
			buffer = "";
		},
	};
}
