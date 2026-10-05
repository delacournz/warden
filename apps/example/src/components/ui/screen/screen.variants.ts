import type { VariantProps } from "tailwind-variants";
import { tv } from "@/lib/tv";

/** Where a navbar or footer sits: over the content, or in the flow above and below it. */
export const SCREEN_PLACEMENTS = ["overlay", "static"] as const;

export type ScreenPlacement = (typeof SCREEN_PLACEMENTS)[number];

/**
 * Safe-area edges a container can inset against.
 *
 * Structurally `Edge` from react-native-safe-area-context, restated here so
 * this module keeps its promise of importing nothing — the whole reason it is
 * reachable from `bun test`.
 */
export const SCREEN_EDGES = ["top", "right", "bottom", "left"] as const;

export type ScreenEdge = (typeof SCREEN_EDGES)[number];

/**
 * Styling for every part of a screen.
 *
 * One slotted `tv()` rather than a call per part, so `placement` — the axis the
 * navbar and the footer both turn on — is declared once. The two read the same
 * variant and get different classes from it, which is what keeps "overlay" from
 * meaning `top-0` in one file and `bottom-0` in another.
 *
 * Colour lives on the text slots (`navbarTitle`, `navbarSubtitle`,
 * `errorTitle`, `errorMessage`) and never on a container. A React Native `View`
 * does not cascade colour to a `Text` descendant the way a DOM element does, so
 * a `text-*` on `navbarRow` would simply do nothing — the tests assert it stays
 * off.
 *
 * Safe-area padding is deliberately absent here. Uniwind's `pt-safe` and
 * friends compile to `env(safe-area-inset-*)`, which resolves to zero on React
 * Native — see {@link resolveScreenEdgePadding}.
 *
 * `navbarBackground` clips: the hairline it holds is positioned against the
 * navbar's own box, and the safe-area band has to be painted too or the status
 * bar shows content scrolling underneath it.
 *
 * Free of React Native imports so it stays unit-testable — `bun test` cannot
 * parse React Native's Flow-typed source. See AGENTS.md.
 */
export const screenVariants = tv({
	slots: {
		root: "flex-1 bg-background",
		content: "flex-1 bg-background",
		view: "flex-1",
		/**
		 * The default padding inside a scrollable, on the token every other edge of
		 * the screen lines up with.
		 *
		 * The library owns it so a screen does not repeat it — twelve call sites
		 * writing `p-5`, `px-5`, `py-5` and `px-5 pt-4` by hand is how they drifted
		 * apart. A caller overrides per axis (`px-0` for full-bleed rows) and
		 * tailwind-merge resolves it, because `screen-gutter` is registered in
		 * `styles/tokens.ts`.
		 *
		 * On a virtualised list this is not a double count. Content-container
		 * padding wraps `ListHeaderComponent`, so the order down the screen is
		 * padding, then the navbar spacer, then the rows — and the spacer sits
		 * behind the overlaying navbar, leaving exactly one gutter of visible
		 * breathing room, the same as a scroll area.
		 */
		scrollContent: "p-screen-gutter",
		/**
		 * A titled block inside a scrollable, which already carries the gutter and
		 * the vertical rhythm — so the header adds neither, or every screen would
		 * need `px-0` to undo the second one.
		 *
		 * `gap-1` is its OWN rhythm, between a title and whatever sits under it,
		 * and it is deliberately not the empty string: `tv()` returns `undefined`
		 * for a slot with no classes at all, which reads as a bug at the call site
		 * and breaks any test that asserts on it.
		 */
		header: "gap-1",
		/**
		 * Above the content it overlays. The navbar is the FIRST child of a
		 * screen, so without a raised z-index a later sibling paints over it —
		 * the footer already wins by document order, which is what a footer
		 * should do.
		 */
		navbar: "z-50",
		navbarRow: "h-navbar-row flex-row items-center justify-between gap-2 px-screen-gutter",
		navbarStart: "min-w-0 flex-1 flex-row items-center gap-2",
		navbarActions: "flex-row items-center gap-2",
		navbarCenter: "absolute top-0 right-0 bottom-0 left-0 flex-row items-center justify-center gap-2",
		navbarBackground: "absolute top-0 right-0 bottom-0 left-0 overflow-hidden bg-background",
		navbarBorder: "absolute right-0 bottom-0 left-0 h-px bg-border",
		/**
		 * No text alignment of its own. In the `center` slot the flex row already
		 * centres it, so `text-center` was redundant there — and in the leading slot
		 * it actively fought a title stacked above a subtitle, centring one line in a
		 * column that should read left-aligned.
		 */
		navbarTitle: "text-foreground text-lg font-semibold leading-tight",
		navbarSubtitle: "text-muted-foreground text-sm",
		backButton: "flex-row items-center gap-2",
		footer: "",
		/**
		 * The footer's own backing, filling the box that travels with the keyboard.
		 *
		 * Opaque only when the footer is `static`. A static footer is chrome: it
		 * takes its own space in the flow, and the content above it must not show
		 * through when the keyboard lifts it over that content. An `overlay` footer
		 * is the opposite — a surface floating above content that deliberately
		 * scrolls under it — so it stays transparent and whatever the caller puts
		 * inside brings its own background.
		 */
		footerBackground: "absolute top-0 right-0 bottom-0 left-0",
		/**
		 * The hairline along the footer's TOP edge — the mirror of the navbar's,
		 * which runs along its bottom. Drawn only for a `static` footer, since an
		 * overlay one floats and a rule across the screen above it would read as a
		 * divider belonging to the content.
		 */
		footerBorder: "absolute top-0 right-0 left-0 h-px",
		/**
		 * The footer's measured content box, and the owner of its HORIZONTAL
		 * padding.
		 *
		 * Horizontal lives here rather than in the sticky view's inline style so it
		 * can use the same gutter token as the content above — a footer button used
		 * to sit at 16 while the content sat at 20, on every screen with a footer.
		 * The vertical stays inline, because `footerOccupancy` has to add the same
		 * numbers to a height measured at runtime and a class is unreadable from
		 * JS. Only the axis that was wrong moved, so the occupancy maths is
		 * untouched.
		 */
		footerContent: "gap-2 px-screen-gutter",
		loading: "flex-1 items-center justify-center",
		errorContent: "flex-1 items-center justify-center gap-3 px-screen-gutter",
		errorTitle: "text-center font-semibold text-foreground text-lg",
		errorMessage: "text-center text-muted-foreground text-sm",
	},
	variants: {
		placement: {
			overlay: {
				navbar: "absolute top-0 right-0 left-0",
				footer: "absolute right-0 bottom-0 left-0",
			},
			static: {
				navbar: "relative",
				footer: "relative",
				footerBackground: "bg-background",
				footerBorder: "bg-border",
			},
		},
	},
	defaultVariants: {
		placement: "overlay",
	},
});

/**
 * Scroll distance over which a hairline fades, in points.
 *
 * One constant for both edges: the navbar's line and the footer's are the same
 * idea at opposite ends of the content, and two numbers that should always
 * agree are two numbers that can drift.
 *
 * Short on purpose. The line answers a yes/no question — is there content that
 * way? — and a longer ramp reads as the border being slow rather than as a
 * response.
 */
export const SCREEN_BORDER_FADE_DISTANCE = 20;

/**
 * Opacity of the navbar's bottom hairline.
 *
 * Drawn at full strength at rest unless `fadeOnScroll` is on, which is what
 * makes an undivided header opt-in rather than the default — a screen whose
 * content starts flush against the bar wants the line from the first frame, and
 * used to re-add one by hand precisely because it faded.
 *
 * With `fadeOnScroll`, ramps 0 → 1 over the first
 * {@link SCREEN_BORDER_FADE_DISTANCE} points and clamps at both ends —
 * a rubber-banded overscroll reports a negative offset, which would otherwise
 * drive the opacity below zero.
 *
 * Pure, so the whole ramp is reachable from `bun test`. Written out rather than
 * calling Reanimated's `interpolate` so this module keeps its promise of
 * importing nothing. See AGENTS.md.
 */
export function resolveNavbarBorderOpacity(scrollY: number, fadeOnScroll: boolean): number {
	"worklet";
	if (!fadeOnScroll) return 1;
	// The clamp is written out in both resolvers rather than shared. A module
	// helper called from a worklet is not always captured into the UI runtime's
	// closure, and the failure is a runtime "undefined is not a function" on the
	// UI thread that no unit test sees — the JS thread resolves it fine.
	return Math.min(1, Math.max(0, scrollY / SCREEN_BORDER_FADE_DISTANCE));
}

/**
 * Opacity of the footer's top hairline.
 *
 * The mirror of {@link resolveNavbarBorderOpacity}, and deliberately not the
 * same input. The navbar's line answers "is there content ABOVE?", so it reads
 * the near end of the scroll; the footer's answers "is there content BELOW?",
 * so it reads the far end and fades OUT as the content runs out. A footer line
 * driven by `scrollY` would be brightest exactly where there is nothing left to
 * scroll to.
 *
 * `contentHeight` and `layoutHeight` are published by the scrollable's own
 * scroll events, so both are 0 until the first one arrives. Unmeasured is
 * treated as "draw it": before any scroll a screen tall enough to scroll does
 * have content below, and a screen too short to scroll never contradicts it.
 *
 * Pure, so the whole ramp is reachable from `bun test`. See AGENTS.md.
 */
export function resolveFooterBorderOpacity(state: {
	/** Live scroll offset. */
	scrollY: number;
	/** Total scrollable content height, or 0 before the first scroll event. */
	contentHeight: number;
	/** Viewport height, or 0 before the first scroll event. */
	layoutHeight: number;
	fadeOnScroll: boolean;
}): number {
	"worklet";
	if (!state.fadeOnScroll) return 1;
	if (state.contentHeight <= 0) return 1;

	const remaining = state.contentHeight - state.layoutHeight - state.scrollY;
	// Written out rather than shared with the navbar's ramp — see the note there.
	return Math.min(1, Math.max(0, remaining / SCREEN_BORDER_FADE_DISTANCE));
}

/** The four safe-area insets, as `useSafeAreaInsets()` reports them. */
export type ScreenEdgeInsets = { top: number; right: number; bottom: number; left: number };

/** Padding for a container insetting itself against some of the safe area. */
export type ScreenEdgePadding = {
	paddingTop?: number;
	paddingRight?: number;
	paddingBottom?: number;
	paddingLeft?: number;
};

/**
 * Safe-area padding for a set of edges.
 *
 * Values from `useSafeAreaInsets()` rather than uniwind's `pt-safe` utilities,
 * which compile to `env(safe-area-inset-*)` and resolve to **zero** on React
 * Native — a silent no-op, which is the worst kind of wrong for a notch. The
 * hook is also the same source the footer's occupancy maths reads, so a
 * container's inset and the reserve computed against it cannot disagree.
 *
 * **Only the edges asked for appear.** An unrequested edge is absent, not `0`.
 * A `0` here is not a harmless absence — it is a value, and it wins: uniwind
 * puts a className's style first and the `style` prop second, and Yoga resolves
 * a longhand edge ahead of the `padding` shorthand a class compiles to,
 * treating `0` as defined. So four unconditional zeroes silently erased every
 * side of a caller's `p-5`. Emitting a partial is half the fix; the other half
 * is that a caller's className belongs on a different box entirely — see
 * `screen-header.tsx`.
 *
 * Pure, so the whole matrix is reachable from `bun test`. See AGENTS.md.
 */
export function resolveScreenEdgePadding(
	edges: readonly ScreenEdge[] | undefined,
	insets: ScreenEdgeInsets
): ScreenEdgePadding {
	const padding: ScreenEdgePadding = {};
	if (!edges?.length) return padding;

	if (edges.includes("top")) padding.paddingTop = insets.top;
	if (edges.includes("right")) padding.paddingRight = insets.right;
	if (edges.includes("bottom")) padding.paddingBottom = insets.bottom;
	if (edges.includes("left")) padding.paddingLeft = insets.left;

	return padding;
}

/*
 * How much vertical space `Screen.Footer` takes away from a scrollable, kept
 * here so the arithmetic is unit-testable and cannot drift from the footer's
 * own render.
 *
 * There are TWO different numbers below and conflating them is a real bug —
 * they differ by exactly the safe-area inset:
 *
 * - `footerOccupancy` — what the footer covers in LIST-CONTENT space.
 * - `footerAboveKeyboard` — what it covers ABOVE AN OPEN KEYBOARD.
 *
 * ## Why occupancy is the same in both keyboard states
 *
 * For keyboard height `K`, safe-area inset `b`, measured content `m`, and the
 * footer's own chrome `c = SCREEN_FOOTER_PADDING + SCREEN_FLOATING_BOTTOM_GAP`:
 *
 * - CLOSED: the footer's top edge sits `c + m + b` above the screen bottom, and
 *   the list's content bottom IS the screen bottom. Reserve = `c + m + b`.
 * - OPEN: `KeyboardStickyView` translates by `-(K - b)` (its `offset.opened` is
 *   the inset), so the footer's `b` band ends up BEHIND the keyboard and its top
 *   edge is `keyboardTop - (c + m)`. The list lifts by `(K - b)`, because
 *   `KeyboardChatScrollView` scrolls by "distance (`keyboardHeight - offset`)
 *   instead of the full keyboard height" and `Screen.ChatList` passes the inset
 *   as that offset. Measured from the lifted content bottom, the footer's top is
 *   once again `c + m + b` away.
 *
 * So ONE static spacer is correct in both states: `b` is real padding while
 * closed and list-lift compensation while open. Omitting it — on the theory that
 * the sticky shift "discards" it — leaves every chat list short by the inset,
 * correct to within 2pt on a 34pt-inset phone and 32pt wrong on a zero-inset
 * one.
 *
 * `footerAboveKeyboard` is the exception, and only because it answers a
 * different question: `KeyboardAwareScrollView`'s `bottomOffset` is the
 * clearance between the FOCUSED INPUT and the keyboard's top edge, so the band
 * already hidden behind the keyboard must not be counted.
 *
 * These stay numbers rather than joining the tokens in `tokens.css`. The footer
 * applies them as an inline `style` precisely because `footerOccupancy` has to
 * add the same band to a height measured at runtime, and a class is unreadable
 * from JS. One constant driving both the render and the reserve is what stops a
 * scrollable clearing the wrong distance.
 */

/** `Screen.Footer`'s padding on its top and side edges. */
export const SCREEN_FOOTER_PADDING = 16;

/**
 * Gap between the safe-area edge and a floating bottom surface.
 *
 * Separate from {@link SCREEN_FOOTER_PADDING} because the bottom edge is
 * measured against whatever else can occupy that corner of the screen — a tab
 * bar, a composer pill — and a few points of difference between them reads as
 * the surface jumping on navigation.
 */
export const SCREEN_FLOATING_BOTTOM_GAP = 12;

/** Breathing room between a chat's newest message and the composer above it. */
export const CHAT_COMPOSER_GAP = 16;

/**
 * Vertical space the footer takes from a scrollable's content, in list-content
 * space. Identical whether the keyboard is open or closed — see the block above.
 *
 * @param measuredContentHeight - `footer.height` / `footer.initialHeight`, what `Screen.Footer` measures
 * @param safeAreaBottom - `useSafeAreaInsets().bottom`
 */
export function footerOccupancy(measuredContentHeight: number, safeAreaBottom: number): number {
	"worklet";
	return measuredContentHeight + SCREEN_FOOTER_PADDING + SCREEN_FLOATING_BOTTOM_GAP + safeAreaBottom;
}

/**
 * Vertical space the footer takes ABOVE AN OPEN KEYBOARD. Excludes the
 * safe-area band, which the sticky shift parks behind the keyboard.
 *
 * For `KeyboardAwareScrollView`'s `bottomOffset` — clearance between the focused
 * input and the keyboard top, not clearance in content space.
 */
export function footerAboveKeyboard(measuredContentHeight: number): number {
	"worklet";
	return measuredContentHeight + SCREEN_FOOTER_PADDING + SCREEN_FLOATING_BOTTOM_GAP;
}

/** How a scrollable reserves space at its bottom edge. See {@link resolveScrollBottomInset}. */
export const SCREEN_SCROLL_INSET_MODES = ["standard", "keyboard-aware", "chat"] as const;

export type ScreenScrollInsetMode = (typeof SCREEN_SCROLL_INSET_MODES)[number];

/**
 * The spacer height a scrollable needs below its content.
 *
 * Reserves the footer's OCCUPANCY, not its measured content height. The two
 * differ by the footer's own chrome, so reserving the measured height alone
 * leaves the last row sitting 28pt behind the footer's top edge — visible under
 * `<Screen debug>` as a red band above the green one.
 *
 * A `static` footer needs no reserve at all: it sits in the flow below the
 * scrollable and carries its own safe-area padding, so counting it here would
 * strand an empty band the height of the footer.
 *
 * With no footer mounted the reserve is the bare safe-area band, which fades out
 * as the keyboard covers it — the inset is meaningless behind a keyboard.
 *
 * Pure, so the whole matrix is reachable from `bun test`. See AGENTS.md.
 */
export function resolveScrollBottomInset(state: {
	mode: ScreenScrollInsetMode;
	/** `footer.height` — content only, excluding the footer's padding and safe-area band. */
	footerHeight: number;
	footerPlacement: ScreenPlacement;
	/** `useSafeAreaInsets().bottom`. */
	safeAreaBottom: number;
	/** 0 closed through 1 open. */
	keyboardProgress: number;
	/** Negative while the keyboard is open. */
	keyboardHeight: number;
}): number {
	"worklet";
	const hasFooter = state.footerHeight > 0;

	if (state.mode === "chat") {
		// A chat list is LIFTED by the keyboard rather than padded for it, so no
		// keyboard band belongs here — and the occupancy is correct in both
		// keyboard states, which is why the safe-area inset is not faded either.
		const reserve = hasFooter ? footerOccupancy(state.footerHeight, state.safeAreaBottom) : state.safeAreaBottom;
		return reserve + CHAT_COMPOSER_GAP;
	}

	const fadingSafeArea = state.safeAreaBottom * (1 - state.keyboardProgress);
	// `keyboardHeight` is negative while open, so the band is its negation —
	// clamped, because negating a closed keyboard's 0 yields -0, and a -0 height
	// reaching a native view is a surprise waiting to happen.
	//
	// `keyboard-aware` omits the band entirely: `KeyboardAwareScrollView` adds
	// that padding itself, and adding it twice leaves a keyboard-sized gap.
	const keyboardBand = state.mode === "keyboard-aware" ? 0 : Math.max(0, -state.keyboardHeight);

	if (!hasFooter) return fadingSafeArea + keyboardBand;
	if (state.footerPlacement === "static") return keyboardBand;

	return footerOccupancy(state.footerHeight, fadingSafeArea) + keyboardBand;
}

/**
 * The height of a scrollable's top spacer.
 *
 * Mirrors the top half of {@link resolveScreenViewPadding}, including the
 * fallback that matters most: with NO navbar mounted the spacer is the raw
 * safe-area inset, not zero. Without it a screen that skips the navbar runs its
 * first row under the notch — the scroll area had no fallback while the static
 * body did, so the two disagreed about the same screen.
 *
 * A `static` navbar contributes nothing: it already took its space in the flow.
 *
 * Pure, so the whole matrix is reachable from `bun test`. See AGENTS.md.
 */
export function resolveScrollTopInset(state: {
	navbarHeight: number;
	navbarPlacement: ScreenPlacement;
	safeAreaTop: number;
}): number {
	"worklet";
	if (state.navbarHeight <= 0) return state.safeAreaTop;
	return state.navbarPlacement === "overlay" ? state.navbarHeight : 0;
}

/**
 * The padding a non-scrolling body needs to clear the screen's chrome.
 *
 * Falls back to the raw safe-area inset on an edge with no chrome on it, so a
 * screen with no navbar still clears the notch. A `static` navbar or footer
 * contributes nothing: it already took its space in the flow.
 *
 * Pure, so the whole matrix is reachable from `bun test`. See AGENTS.md.
 */
export function resolveScreenViewPadding(state: {
	navbarHeight: number;
	navbarPlacement: ScreenPlacement;
	footerHeight: number;
	footerPlacement: ScreenPlacement;
	safeAreaTop: number;
	safeAreaBottom: number;
}): { paddingTop: number; paddingBottom: number } {
	"worklet";
	const hasNavbar = state.navbarHeight > 0;
	const paddingTop = hasNavbar ? (state.navbarPlacement === "overlay" ? state.navbarHeight : 0) : state.safeAreaTop;

	const hasFooter = state.footerHeight > 0;
	const paddingBottom = hasFooter
		? state.footerPlacement === "overlay"
			? footerOccupancy(state.footerHeight, state.safeAreaBottom)
			: 0
		: state.safeAreaBottom;

	return { paddingBottom, paddingTop: paddingTop };
}

export type ScreenVariantProps = VariantProps<typeof screenVariants>;
