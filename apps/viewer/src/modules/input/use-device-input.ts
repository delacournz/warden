import { type PointerEvent, useCallback, useEffect, useRef, type WheelEvent } from "react";
import * as device from "../../core/api/device.api.ts";
import {
	accumulateWheel,
	classifyGesture,
	classifyKey,
	createTextBatcher,
	type Gesture,
	initialWheelState,
	type PointerSample,
	type Rect,
	type WheelState,
} from "./input.ts";

const KEY_DEBOUNCE_MS = 150;

/** The element showing the device: `<video>` (webview WebRTC) or `<canvas>` (native stream). */
export type Screen = HTMLVideoElement | HTMLCanvasElement;

export type DeviceInputHandlers = {
	onPointerDown: (event: PointerEvent<Screen>) => void;
	onPointerUp: (event: PointerEvent<Screen>) => void;
	onWheel: (event: WheelEvent<Screen>) => void;
};

function boxOf(screen: Screen): Rect {
	const r = screen.getBoundingClientRect();
	return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** The picture's pixel size: the video's intrinsic size, or the canvas backing store. */
function pictureOf(screen: Screen): { width: number; height: number } {
	return screen instanceof HTMLVideoElement
		? { width: screen.videoWidth, height: screen.videoHeight }
		: { width: screen.width, height: screen.height };
}

function isTextField(target: EventTarget | null): boolean {
	return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

function send(gesture: Gesture): Promise<void> {
	return gesture.kind === "tap"
		? device.tap(gesture.x, gesture.y)
		: device.drag({
				fromX: gesture.fromX,
				fromY: gesture.fromY,
				toX: gesture.toX,
				toY: gesture.toY,
				durationMs: gesture.durationMs,
			});
}

/**
 * Forward pointer, wheel, key and paste input to the device. With `enabled` false (watch mode or a
 * view-scope token) nothing is sent and no listener is added. Failures go to `onError`.
 */
export function useDeviceInput(enabled: boolean, onError: (message: string) => void): DeviceInputHandlers {
	const down = useRef<PointerSample | null>(null);
	const wheel = useRef<WheelState>(initialWheelState);
	const report = useCallback((e: unknown) => onError(e instanceof Error ? e.message : String(e)), [onError]);

	useEffect(() => {
		if (!enabled) return;
		const batcher = createTextBatcher({
			send: (text) => device.input(text).catch(report),
			delayMs: KEY_DEBOUNCE_MS,
			setTimer: (fn, ms) => setTimeout(fn, ms),
			clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		});
		const onKeyDown = (event: KeyboardEvent) => {
			if (isTextField(event.target)) return;
			const action = classifyKey(event);
			if (!action) return;
			event.preventDefault();
			batcher.push(action.kind === "newline" ? "\n" : action.text);
			if (action.kind === "newline") batcher.flush();
		};
		const onPaste = (event: ClipboardEvent) => {
			if (isTextField(event.target)) return;
			const text = event.clipboardData?.getData("text/plain");
			if (!text) return;
			event.preventDefault();
			batcher.flush();
			device.input(text).catch(report);
		};
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("paste", onPaste);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("paste", onPaste);
			batcher.flush();
		};
	}, [enabled, report]);

	const onPointerDown = useCallback(
		(event: PointerEvent<Screen>) => {
			if (!enabled) return;
			event.currentTarget.setPointerCapture(event.pointerId);
			down.current = { clientX: event.clientX, clientY: event.clientY, t: event.timeStamp };
		},
		[enabled]
	);

	const onPointerUp = useCallback(
		(event: PointerEvent<Screen>) => {
			const start = down.current;
			down.current = null;
			if (!enabled || !start) return;
			const screen = event.currentTarget;
			const picture = pictureOf(screen);
			const gesture = classifyGesture(
				start,
				{ clientX: event.clientX, clientY: event.clientY, t: event.timeStamp },
				boxOf(screen),
				picture.width,
				picture.height
			);
			if (gesture) send(gesture).catch(report);
		},
		[enabled, report]
	);

	const onWheel = useCallback(
		(event: WheelEvent<Screen>) => {
			if (!enabled) return;
			const screen = event.currentTarget;
			const picture = pictureOf(screen);
			const result = accumulateWheel(
				wheel.current,
				{
					clientX: event.clientX,
					clientY: event.clientY,
					deltaX: event.deltaX,
					deltaY: event.deltaY,
					t: event.timeStamp,
				},
				boxOf(screen),
				picture.width,
				picture.height
			);
			wheel.current = result.state;
			if (result.swipe) send(result.swipe).catch(report);
		},
		[enabled, report]
	);

	return { onPointerDown, onPointerUp, onWheel };
}
