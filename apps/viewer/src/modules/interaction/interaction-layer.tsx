import { Keyboard } from "@phosphor-icons/react";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { type DeviceActions, logActions } from "./device-actions.ts";
import { DeviceMenu, type MenuAnchor, type MenuChoice } from "./device-menu.tsx";
import { TextDialog } from "./dialogs.tsx";
import {
	type DisplayOrientation,
	displayPicture,
	mirrorThroughCentre,
	type Point,
	pictureFit,
	type Size,
	toInteractionPoint,
} from "./geometry.ts";
import { createTextBatcher } from "./text-batcher.ts";
import { type Fingers, MultiTouchFeedback, TouchFeedback } from "./touch-overlay.tsx";
import { createMultiTouchSession, createTouchSession } from "./touch-session.ts";
import {
	idleTouch,
	moveTouch,
	pressTouch,
	RELEASE_REMOVE_MS,
	releaseTouch,
	removeTouch,
	type TouchOverlay,
} from "./touch-state.ts";
import { classifyTypingKey, TYPING_BUFFER_MS } from "./typing-keys.ts";

type ScreenElement = HTMLVideoElement | HTMLCanvasElement;

type InteractionLayerProps = {
	enabled: boolean;
	/** The device size in points; until known, an iPhone 16 Pro Max (440x956). */
	deviceSize?: Size;
	/** How the picture is shown; landscape means the portrait frame is turned a quarter. */
	orientation?: DisplayOrientation;
	actions?: DeviceActions;
	className?: string;
	style?: CSSProperties;
	children: ReactNode;
};

const DEFAULT_DEVICE_SIZE: Size = { width: 440, height: 956 };

type MenuState = { anchor: MenuAnchor; point: Point };

function screenIn(container: HTMLElement): ScreenElement | null {
	return container.querySelector<ScreenElement>("canvas, video");
}

function pictureOf(screen: ScreenElement): Size {
	return screen instanceof HTMLVideoElement
		? { width: screen.videoWidth, height: screen.videoHeight }
		: { width: screen.width, height: screen.height };
}

function isTextField(target: EventTarget | null): boolean {
	return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

/**
 * Wraps the device picture (a `<video>` or `<canvas>` child) with the interaction layer: touch
 * feedback visuals, Alt two-finger mode, the right-click menu, and typing mode. It listens on the
 * wrapper with native listeners and sends the result through `actions` (device points, mapped
 * with `deviceSize`). Visuals and handlers are off when `enabled` is false. The overlays are siblings of the picture, in container
 * CSS px, and ignore pointer events. Typing mode starts after a tap and ends on Escape, and shows a
 * small "Typing" badge while it is on.
 */
export function InteractionLayer({
	enabled,
	deviceSize = DEFAULT_DEVICE_SIZE,
	orientation = "portrait",
	actions = logActions,
	className,
	style,
	children,
}: InteractionLayerProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [touch, setTouch] = useState<TouchOverlay>(idleTouch);
	const [fingers, setFingers] = useState<Fingers | null>(null);
	const [menu, setMenu] = useState<MenuState | null>(null);
	const [typing, setTyping] = useState(false);
	const [textOpen, setTextOpen] = useState(false);
	const suspended = menu !== null || textOpen;
	const suspendedRef = useRef(suspended);
	suspendedRef.current = suspended;
	const sizeRef = useRef(deviceSize);
	sizeRef.current = deviceSize;
	const orientationRef = useRef(orientation);
	orientationRef.current = orientation;
	const actionsRef = useRef(actions);
	actionsRef.current = actions;

	useEffect(() => {
		const container = containerRef.current;
		if (!enabled || !container) return;

		const single = createTouchSession(actions);
		const multi = createMultiTouchSession(actions);
		let lastId = 0;
		let altDown = false;
		let pressed: "single" | "multi" | null = null;
		let pointer: Point | null = null;
		let removeTimer: ReturnType<typeof setTimeout> | null = null;

		const rel = (client: Point): Point => {
			const box = container.getBoundingClientRect();
			return { x: client.x - box.left, y: client.y - box.top };
		};
		const geometry = () => {
			const screen = screenIn(container);
			if (!screen) return null;
			const box = screen.getBoundingClientRect();
			const picture = pictureOf(screen);
			const fit = pictureFit(box, displayPicture(picture, orientationRef.current));
			return fit ? { box, picture, fit } : null;
		};
		const fingerPair = (client: Point, fit: ReturnType<typeof pictureFit>) => {
			const mirrored = fit ? mirrorThroughCentre(client, fit) : client;
			return { first: client, second: mirrored };
		};
		const toTouches = (pair: { first: Point; second: Point }, g: NonNullable<ReturnType<typeof geometry>>) => {
			const map = (p: Point) =>
				toInteractionPoint(p.x, p.y, g.box, g.picture, sizeRef.current, {
					clamp: true,
					orientation: orientationRef.current,
				});
			const a = map(pair.first);
			const b = map(pair.second);
			return a && b
				? [
						{ id: 1, ...a },
						{ id: 2, ...b },
					]
				: null;
		};
		const centreDistance = (pair: { first: Point }, fit: NonNullable<ReturnType<typeof pictureFit>>) =>
			Math.hypot(pair.first.x - (fit.left + fit.width / 2), pair.first.y - (fit.top + fit.height / 2));
		const showFingers = (client: Point | null, isPressed: boolean) => {
			const g = geometry();
			const centre = g ? { x: g.fit.left + g.fit.width / 2, y: g.fit.top + g.fit.height / 2 } : { x: 0, y: 0 };
			const first = client ?? centre;
			const pair = fingerPair(first, g?.fit ?? null);
			setFingers({ first: rel(pair.first), second: rel(pair.second), pressed: isPressed });
		};

		type Geometry = NonNullable<ReturnType<typeof geometry>>;

		const pressMulti = (client: Point, g: Geometry, t: number) => {
			const pair = fingerPair(client, g.fit);
			const touches = toTouches(pair, g);
			if (!touches) return;
			pressed = "multi";
			multi.down(touches, centreDistance(pair, g.fit), t);
			showFingers(client, true);
		};
		const pressSingle = (client: Point, device: Point, t: number) => {
			pressed = "single";
			single.down(device, client, t);
			const local = rel(client);
			setTouch((current) => {
				const next = pressTouch(current, local.x, local.y, lastId);
				lastId = next.id;
				return next;
			});
		};
		const moveMulti = (client: Point, g: Geometry, t: number) => {
			const pair = fingerPair(client, g.fit);
			const touches = toTouches(pair, g);
			if (touches) multi.move(touches, centreDistance(pair, g.fit), t);
			showFingers(client, true);
		};
		const moveSingle = (client: Point, g: Geometry, t: number) => {
			const device = toInteractionPoint(client.x, client.y, g.box, g.picture, sizeRef.current, {
				clamp: true,
				orientation: orientationRef.current,
			});
			if (device) single.move(device, client, t);
			const local = rel(client);
			setTouch((current) => moveTouch(current, local.x, local.y));
		};
		const endMulti = (client: Point, g: Geometry) => {
			const pair = fingerPair(client, g.fit);
			const touches = toTouches(pair, g);
			if (touches) multi.up(touches, centreDistance(pair, g.fit));
			if (altDown) showFingers(client, false);
		};
		const endSingle = (client: Point, g: Geometry, t: number) => {
			const device = toInteractionPoint(client.x, client.y, g.box, g.picture, sizeRef.current, {
				clamp: true,
				orientation: orientationRef.current,
			});
			const gesture = device ? single.up(device, client, t) : null;
			setTouch((current) => releaseTouch(current));
			removeTimer = setTimeout(() => {
				setTouch((current) => (current ? removeTouch(current, current.id) : current));
			}, RELEASE_REMOVE_MS);
			if (gesture === "tap") setTyping(true);
		};

		const pressTarget = (event: PointerEvent) => {
			const screen = screenIn(container);
			const primary = event.button === 0 && event.isPrimary;
			const g = primary && screen && event.target === screen ? geometry() : null;
			if (!g) return null;
			const client = { x: event.clientX, y: event.clientY };
			const device = toInteractionPoint(client.x, client.y, g.box, g.picture, sizeRef.current, {
				orientation: orientationRef.current,
			});
			return device ? { g, client, device } : null;
		};

		const onPointerDown = (event: PointerEvent) => {
			const target = pressTarget(event);
			if (!target) return;
			if (removeTimer) clearTimeout(removeTimer);
			if (altDown || event.altKey) {
				altDown = true;
				pressMulti(target.client, target.g, event.timeStamp);
			} else {
				pressSingle(target.client, target.device, event.timeStamp);
			}
		};

		const onPointerMove = (event: PointerEvent) => {
			const client = { x: event.clientX, y: event.clientY };
			pointer = client;
			const g = geometry();
			if (!g) return;
			if (pressed === "multi") moveMulti(client, g, event.timeStamp);
			else if (pressed === "single") moveSingle(client, g, event.timeStamp);
			else if (altDown) showFingers(client, false);
		};

		const onPointerEnd = (event: PointerEvent) => {
			if (!pressed || !event.isPrimary) return;
			const g = geometry();
			const mode = pressed;
			pressed = null;
			if (!g) return;
			const client = { x: event.clientX, y: event.clientY };
			if (mode === "multi") endMulti(client, g);
			else endSingle(client, g, event.timeStamp);
		};

		const onContextMenu = (event: MouseEvent) => {
			const screen = screenIn(container);
			if (!screen || event.target !== screen) return;
			event.preventDefault();
			const g = geometry();
			if (!g) return;
			const point = toInteractionPoint(event.clientX, event.clientY, g.box, g.picture, sizeRef.current, {
				orientation: orientationRef.current,
			});
			if (!point) return;
			setMenu({ anchor: { clientX: event.clientX, clientY: event.clientY }, point });
		};

		const onAltKey = (event: KeyboardEvent) => {
			if (event.key !== "Alt") return;
			const down = event.type === "keydown";
			if (down === altDown) return;
			altDown = down;
			if (down) showFingers(pointer, pressed === "multi");
			else if (pressed !== "multi") setFingers(null);
		};
		const onBlur = () => {
			altDown = false;
			if (pressed !== "multi") setFingers(null);
		};

		container.addEventListener("pointerdown", onPointerDown);
		container.addEventListener("pointermove", onPointerMove);
		container.addEventListener("pointerup", onPointerEnd);
		container.addEventListener("pointercancel", onPointerEnd);
		container.addEventListener("contextmenu", onContextMenu);
		window.addEventListener("keydown", onAltKey);
		window.addEventListener("keyup", onAltKey);
		window.addEventListener("blur", onBlur);
		return () => {
			container.removeEventListener("pointerdown", onPointerDown);
			container.removeEventListener("pointermove", onPointerMove);
			container.removeEventListener("pointerup", onPointerEnd);
			container.removeEventListener("pointercancel", onPointerEnd);
			container.removeEventListener("contextmenu", onContextMenu);
			window.removeEventListener("keydown", onAltKey);
			window.removeEventListener("keyup", onAltKey);
			window.removeEventListener("blur", onBlur);
			if (removeTimer) clearTimeout(removeTimer);
			setTouch(idleTouch);
			setFingers(null);
			setTyping(false);
		};
	}, [enabled, actions]);

	useEffect(() => {
		if (!enabled || !typing) return;
		const batcher = createTextBatcher({
			send: (text) => actionsRef.current.inputText({ text }),
			delayMs: TYPING_BUFFER_MS,
			setTimer: (fn, ms) => setTimeout(fn, ms),
			clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		});
		const onKeyDown = (event: KeyboardEvent) => {
			if (suspendedRef.current || isTextField(event.target)) return;
			const action = classifyTypingKey(event);
			if (!action || action.kind === "paste") return;
			event.preventDefault();
			if (action.kind === "text") batcher.push(action.text);
			else if (action.kind === "key") {
				batcher.flush();
				actionsRef.current.key({ key: action.key });
			} else {
				batcher.flush();
				setTyping(false);
			}
		};
		const onPaste = (event: ClipboardEvent) => {
			if (suspendedRef.current || isTextField(event.target)) return;
			event.preventDefault();
			batcher.flush();
			actionsRef.current.inputText({ text: event.clipboardData?.getData("text/plain") ?? "", paste: true });
		};
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("paste", onPaste);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("paste", onPaste);
			batcher.flush();
		};
	}, [enabled, typing]);

	const choose = (choice: MenuChoice) => {
		const point = menu?.point;
		setMenu(null);
		if (choice.kind === "shake") return actions.shake({});
		if (choice.kind === "enterText") return setTextOpen(true);
		if (!point) return;
		if (choice.kind === "swipe") return actions.swipe({ ...point, direction: choice.direction });
		if (choice.kind === "pinch") return actions.pinch({ ...point, scale: choice.scale });
		return actions[choice.kind](point);
	};

	return (
		<div ref={containerRef} className={className} style={style}>
			{children}
			{enabled && (
				<>
					<TouchFeedback touch={fingers ? null : touch} />
					<MultiTouchFeedback fingers={fingers} />
					{typing && (
						<span
							role="status"
							className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-1.5 rounded-full border bg-popover/90 px-2 py-1 text-[11px] text-popover-foreground shadow-md/5 backdrop-blur-sm"
						>
							<Keyboard size={12} aria-hidden className="text-primary" />
							Typing
						</span>
					)}
					<DeviceMenu anchor={menu?.anchor ?? null} onOpenChange={(open) => !open && setMenu(null)} onChoose={choose} />
					<TextDialog
						open={textOpen}
						onOpenChange={setTextOpen}
						onSubmit={({ text, clearFirst }) => actions.inputText({ text, clearFirst })}
					/>
				</>
			)}
		</div>
	);
}
