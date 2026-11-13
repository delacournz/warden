import {
	Menu,
	MenuItem,
	MenuPopup,
	MenuSeparator,
	MenuSub,
	MenuSubPopup,
	MenuSubTrigger,
} from "@delacournz/apogee/menu";
import type { PinchScale, SwipeDirection } from "./device-actions.ts";

export type MenuChoice =
	| { kind: "tap" }
	| { kind: "doubleTap" }
	| { kind: "longPress" }
	| { kind: "swipe"; direction: SwipeDirection }
	| { kind: "pinch"; scale: PinchScale }
	| { kind: "shake" }
	| { kind: "enterText" };

export type MenuAnchor = { clientX: number; clientY: number };

type DeviceMenuProps = {
	anchor: MenuAnchor | null;
	onOpenChange: (open: boolean) => void;
	onChoose: (choice: MenuChoice) => void;
};

const SWIPES: readonly { direction: SwipeDirection; label: string }[] = [
	{ direction: "up", label: "Up" },
	{ direction: "down", label: "Down" },
	{ direction: "left", label: "Left" },
	{ direction: "right", label: "Right" },
];

/**
 * Right-click menu on the device picture. It opens at the pointer through a virtual anchor, so no
 * trigger element is needed, and the base-ui menu gives arrow-key navigation, typeahead, submenus
 * and Escape-to-close. Choices act on the device point that was right-clicked (kept by the layer).
 */
export function DeviceMenu({ anchor, onOpenChange, onChoose }: DeviceMenuProps) {
	const virtual = anchor
		? {
				getBoundingClientRect: () => DOMRect.fromRect({ x: anchor.clientX, y: anchor.clientY, width: 0, height: 0 }),
			}
		: undefined;

	return (
		<Menu open={anchor !== null} onOpenChange={onOpenChange}>
			<MenuPopup anchor={virtual} align="start" side="bottom" sideOffset={2} aria-label="Device actions at this point">
				<MenuItem onClick={() => onChoose({ kind: "tap" })}>Tap</MenuItem>
				<MenuItem onClick={() => onChoose({ kind: "doubleTap" })}>Double tap</MenuItem>
				<MenuItem onClick={() => onChoose({ kind: "longPress" })}>Long press</MenuItem>
				<MenuSeparator />
				<MenuSub>
					<MenuSubTrigger>Swipe</MenuSubTrigger>
					<MenuSubPopup>
						{SWIPES.map((s) => (
							<MenuItem key={s.direction} onClick={() => onChoose({ kind: "swipe", direction: s.direction })}>
								{s.label}
							</MenuItem>
						))}
					</MenuSubPopup>
				</MenuSub>
				<MenuSub>
					<MenuSubTrigger>Pinch</MenuSubTrigger>
					<MenuSubPopup>
						<MenuItem onClick={() => onChoose({ kind: "pinch", scale: "zoom_in" })}>Zoom in</MenuItem>
						<MenuItem onClick={() => onChoose({ kind: "pinch", scale: "zoom_out" })}>Zoom out</MenuItem>
					</MenuSubPopup>
				</MenuSub>
				<MenuSeparator />
				<MenuItem onClick={() => onChoose({ kind: "shake" })}>Shake</MenuItem>
				<MenuItem onClick={() => onChoose({ kind: "enterText" })}>Enter text…</MenuItem>
			</MenuPopup>
		</Menu>
	);
}
