import { createContext, type ReactElement, type ReactNode, use, useMemo } from "react";
import { type SharedValue, useSharedValue } from "react-native-reanimated";
import type { ScreenPlacement } from "./screen.variants";

/** What a navbar publishes about itself, for anything that has to clear it. */
export type ScreenNavbarMeasurements = {
	/** Whether the navbar overlays the content or sits in the flow above it. */
	placement: SharedValue<ScreenPlacement>;
	/** Measured height including the safe-area band, or 0 with no navbar mounted. */
	height: SharedValue<number>;
};

/** What a footer publishes about itself, for anything that has to clear it. */
export type ScreenFooterMeasurements = {
	/** Whether the footer overlays the content or sits in the flow below it. */
	placement: SharedValue<ScreenPlacement>;
	/** Content height only — excludes the footer's own padding and safe-area band. */
	height: SharedValue<number>;
	/**
	 * First measured content height — the collapsed baseline; 0 until the footer
	 * mounts. Lets a consumer split the live height into base plus growth.
	 */
	initialHeight: SharedValue<number>;
	/**
	 * Extra VISUAL height overlaying above the measured footer layout — a
	 * composer pill that expands upward without changing its layout box, say.
	 *
	 * Driven as a pure UI-thread animation by the footer's own content (see
	 * `useScreenFooterOverlayHeight`) so a scrollable can offset for it in the
	 * same frame as the keyboard. Never measured via `onLayout`: a layout pass
	 * lands a frame late, which reads as the list lagging the keyboard.
	 *
	 * The footer resets `height` and `initialHeight` when it unmounts but never
	 * this — whoever drives it owns clearing it.
	 */
	overlayHeight: SharedValue<number>;
};

/** Everything a screen's parts share, all of it readable from the UI thread. */
export type ScreenContextValue = {
	navbar: ScreenNavbarMeasurements;
	footer: ScreenFooterMeasurements;
	/** Live scroll offset of whichever scrollable the screen holds. */
	scrollY: SharedValue<number>;
	/** Content height of that scrollable. */
	contentHeight: SharedValue<number>;
	/** Viewport height of that scrollable. */
	layoutHeight: SharedValue<number>;
	/** Paint the screen's layout layers in debug colours. */
	debug: boolean;
};

const ScreenContext = createContext<ScreenContextValue | null>(null);

export type ScreenProviderProps = {
	/**
	 * An enclosing screen's context. When present it is passed straight through
	 * rather than shadowed, so a nested `<Screen>` — which `Screen.Loading` and
	 * `Screen.Error` both produce — keeps reporting to the outer screen's navbar
	 * and footer measurements instead of starting a second, unread set.
	 */
	parentContext?: ScreenContextValue | null;
	/** Paint the screen's layout layers in debug colours. */
	debug?: boolean;
	children: ReactNode;
};

/**
 * Creates the shared values a screen's parts measure themselves into.
 *
 * Every value is a Reanimated `SharedValue` rather than React state: a navbar's
 * height reaching a scrollable's inset through a re-render would land a frame
 * or two after the layout that produced it, and the content would visibly jump
 * into place. On the UI thread the two happen together.
 *
 * Lives in its own module, importing nothing but `screen.variants`, so a part
 * can read the context without importing `../screen` and closing a cycle
 * through `screen.tsx`. See AGENTS.md rule 3.
 */
export function ScreenProvider({ parentContext = null, debug = false, children }: ScreenProviderProps): ReactElement {
	const navbarPlacement = useSharedValue<ScreenPlacement>("overlay");
	const navbarHeight = useSharedValue<number>(0);

	const footerPlacement = useSharedValue<ScreenPlacement>("overlay");
	const footerHeight = useSharedValue<number>(0);
	const footerInitialHeight = useSharedValue<number>(0);
	const footerOverlayHeight = useSharedValue<number>(0);

	const scrollY = useSharedValue<number>(0);
	const contentHeight = useSharedValue<number>(0);
	const layoutHeight = useSharedValue<number>(0);

	const value = useMemo<ScreenContextValue>(() => {
		if (parentContext) return parentContext;

		return {
			navbar: { placement: navbarPlacement, height: navbarHeight },
			footer: {
				placement: footerPlacement,
				height: footerHeight,
				initialHeight: footerInitialHeight,
				overlayHeight: footerOverlayHeight,
			},
			scrollY,
			contentHeight,
			layoutHeight,
			debug,
		};
	}, [
		parentContext,
		navbarPlacement,
		navbarHeight,
		footerPlacement,
		footerHeight,
		footerInitialHeight,
		footerOverlayHeight,
		scrollY,
		contentHeight,
		layoutHeight,
		debug,
	]);

	return <ScreenContext value={value}>{children}</ScreenContext>;
}
ScreenProvider.displayName = "DelacourUI.Screen.Provider";

/** The enclosing screen's context, or null outside a `<Screen>`. */
export function useScreenContext(): ScreenContextValue | null {
	return use(ScreenContext);
}

/**
 * Reads the enclosing screen's navbar and footer measurements.
 *
 * Lets a custom scrollable or a footer's own content clear the screen's chrome
 * without the screen having to pass heights down through every slot. Throws
 * outside a `<Screen>` — use {@link useScreenContext} where the enclosing
 * screen is optional.
 */
export function useScreen(): ScreenContextValue {
	const context = useScreenContext();
	if (!context) {
		throw new Error("useScreen must be called inside a <Screen>.");
	}
	return context;
}

/**
 * The enclosing screen's context, for a compound part that cannot work without
 * one.
 *
 * Internal: deliberately not re-exported from `index.ts`. A caller outside the
 * library wants {@link useScreen}, whose error message names the hook rather
 * than a part.
 */
export function useScreenPart(component: string): ScreenContextValue {
	const context = useScreenContext();
	if (!context) {
		throw new Error(`${component} must be rendered inside a <Screen>.`);
	}
	return context;
}

/** Whether the enclosing screen has layout debugging turned on. */
export function useScreenDebug(): boolean {
	return useScreenContext()?.debug ?? false;
}
