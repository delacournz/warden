import type { VariantProps } from "tailwind-variants";
import { tv } from "@/lib/tv";

/**
 * The scrim token, named here so a test can pin it against `theme.css`.
 *
 * A token rather than a `bg-black/50` written at a call site: the two theme
 * variants carry different alphas, because a pure-black scrim over a near-black
 * dark theme is nearly invisible.
 */
export const BOTTOM_SHEET_OVERLAY_TOKEN = "overlay";

/**
 * The backdrop's opacity at full appearance.
 *
 * **1.** The alpha lives in `--overlay`, so any other number here would multiply
 * against it and land the scrim somewhere the theme did not ask for. One source
 * for the alpha, and it is the token — which is also what lets the two theme
 * variants differ.
 */
export const BOTTOM_SHEET_OVERLAY_OPACITY = 1;

/**
 * The snap point indices the scrim appears and disappears on.
 *
 * A modal sheet has no resting state: it is either presented or gone, so the
 * scrim belongs from the FIRST snap point (`0`) and is only absent when the sheet
 * is closed (`-1`). These are the engine's own defaults too; they are named
 * here so the test that pins them has something to read.
 */
export const BOTTOM_SHEET_BACKDROP_INDICES = { appearsOnIndex: 0, disappearsOnIndex: -1 } as const;

/**
 * Slop around `BottomSheet.Close`.
 *
 * The glyph is a bare icon in a corner with no padded capsule to absorb the
 * difference against the 44pt minimum — the case `Checkbox` mints slop for and
 * `Badge.CloseButton` does not need.
 *
 * **12** per side: the default icon is 20pt (`size-icon-lg`), and 20 + 2 × 12
 * is the 44pt minimum. The pressable has no padding or size of its own to count.
 */
export const BOTTOM_SHEET_CLOSE_HIT_SLOP = 12;

/**
 * The padding a pinned footer's measured box carries.
 *
 * A number rather than a `p-4`, because it is handed to the engine's `padding`
 * prop: the engine measures the footer's inner box into the dynamic snap point,
 * and padding written there is counted where a class on the outer view would
 * not be. The horizontal gutter still comes from the `stickyFooter` slot, which
 * is merged after it.
 */
export const BOTTOM_SHEET_FOOTER_PADDING = 16;

/**
 * The gap between the last of the content and a pinned footer.
 *
 * Also a number, because it is the engine's `footerGap` — added to the spacer it
 * reserves under the body from the footer's measured height. Without it the last
 * row of a list sits flush against the footer's hairline, which reads as content
 * clipped rather than content ended.
 */
export const BOTTOM_SHEET_FOOTER_GAP = 16;

export const bottomSheetVariants = tv({
	slots: {
		/**
		 * The scrim. Carries the colour and nothing else — the fade is an animated
		 * opacity the engine drives off the sheet's own index.
		 */
		overlay: "bg-overlay",
		/**
		 * The sheet's surface. `popover` rather than `card`: a sheet is a layer
		 * over the app, which is what that token already means, and it is the one
		 * surface token nothing else in the package had claimed.
		 *
		 * Only the top corners round. The bottom edge runs off the screen, and a
		 * radius there shows as two notches of the app behind it. The `detached`
		 * variant is the exception — a floating card has a visible bottom edge.
		 */
		background: "rounded-t-2xl bg-popover",
		handle: "items-center justify-center pt-3 pb-1",
		handleIndicator: "h-1 w-9 rounded-full bg-muted-foreground/40",
		content: "gap-4 px-screen-gutter pt-2",
		/** A scrollable body's content container. Same treatment as `content`. */
		scrollContent: "gap-4 px-screen-gutter pt-2",
		/**
		 * A multi-step body. The gutter only: the engine measures each `Step`, not
		 * the box around the stack, so vertical padding here would be height the
		 * sheet never counts.
		 */
		steps: "px-screen-gutter",
		/** One step of a multi-step body — `content` less the gutter `steps` already carries. */
		step: "gap-4 pt-2",
		footer: "gap-3 px-screen-gutter pt-4",
		/**
		 * A pinned footer draws OVER the content, so unlike the inline one it has
		 * to bring a surface and a line of its own — otherwise the content scrolls
		 * straight through it and its buttons are legible only where they happen
		 * to overlap blank space. The same reason `Screen.Footer`'s backing lives
		 * inside its sticky view.
		 *
		 * It carries no vertical padding: that is the engine's `padding` prop, so
		 * the measured box counts it. See {@link BOTTOM_SHEET_FOOTER_PADDING}.
		 */
		stickyFooter: "gap-3 border-border border-t bg-popover px-screen-gutter",
		close: "absolute top-4 right-4 z-10",
		/**
		 * Clearance for `BottomSheet.Close`, and nothing else.
		 *
		 * The close control is absolutely positioned, so it is out of the flow and
		 * a long title runs straight under it. The gutter is reserved on every
		 * sheet rather than only where a close is written, for the reason `Badge`
		 * reserves its border on every variant: declaring it conditionally makes
		 * the title reflow the moment someone adds one.
		 *
		 * No type. That comes from the `Text` preset the part renders, the way
		 * `Field.Label` *is* a `Text.Label` — a `text-lg font-semibold` here would
		 * be a second definition of `Text.Header` that can drift from it.
		 */
		title: "pr-8",
	},
	variants: {
		/**
		 * A floating card. Every corner is on screen, so every corner rounds;
		 * `rounded-2xl` replaces `rounded-t-2xl` through tailwind-merge rather
		 * than stacking beside it.
		 */
		detached: {
			true: {
				background: "rounded-2xl",
			},
		},
	},
});

/**
 * There is no `description`, `panel`, `portal` or `scrollView` slot.
 *
 * None has any layout of its own — a description is a `Text.Paragraph` in a
 * gap column, the panel is a transparent frame the engine positions, a scroll
 * view fills whatever it is given — and `tv` emits `undefined` for a slot whose
 * class string is empty, so a slot that says nothing is a slot no test can
 * assert against. Those parts merge the caller's `className` with `cn()` instead.
 */
export type BottomSheetVariantProps = VariantProps<typeof bottomSheetVariants>;
