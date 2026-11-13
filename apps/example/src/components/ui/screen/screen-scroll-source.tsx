import { type ReactElement, type ReactNode, useMemo } from "react";
import { type ScrollSource, ScrollSourceProvider } from "@/hooks/use-scroll-source";
import { useScreen } from "./screen.context";

export type ScreenScrollSourceBridgeProps = { children: ReactNode };

/**
 * Publishes the screen's scroll values as a `ScrollSource`, so every
 * scroll-linked effect — `ScrollFade` and the rest of its family — works inside
 * a `<Screen>` with no wiring.
 *
 * Built from the shared values the screen already holds rather than new ones:
 * `scrollY` is the offset, `contentHeight` and `layoutHeight` the sizes. Every
 * Screen scrollable writes those from its own scroll handler, so nothing here
 * intercepts a scroll event, and `Screen.ScrollShadow` keeps reading the same
 * values it always did. A Screen body only scrolls vertically, and its
 * scrollable is whichever one is mounted, so there is no ref to hand on.
 *
 * The import runs one way — screen to hook — so installing `useScrollSource`
 * never drags `Screen` and its peers in after it.
 */
export function ScreenScrollSourceBridge({ children }: ScreenScrollSourceBridgeProps): ReactElement {
	const { scrollY, contentHeight, layoutHeight } = useScreen();

	const source = useMemo<ScrollSource>(
		() => ({
			offset: scrollY,
			contentSize: contentHeight,
			layoutSize: layoutHeight,
			orientation: "vertical",
			ref: null,
		}),
		[scrollY, contentHeight, layoutHeight]
	);

	return <ScrollSourceProvider source={source}>{children}</ScrollSourceProvider>;
}
ScreenScrollSourceBridge.displayName = "DelacourUI.Screen.ScrollSourceBridge";
