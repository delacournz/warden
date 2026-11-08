import type { VariantProps } from "tailwind-variants";
import { tv } from "@/lib/tv";

/**
 * The theme token every overlay's scrim paints with.
 *
 * `--overlay` carries its own alpha, and the two themes carry different ones,
 * so a scrim draws it at opacity 1 and fades only through presence — the same
 * rule `BottomSheet.Overlay` follows.
 */
export const OVERLAY_SCRIM_TOKEN = "overlay";

/**
 * How long an overlay takes to arrive and to leave, in milliseconds.
 *
 * Leaving is quicker than arriving: an overlay the user dismissed should get
 * out of the way. Both are finite on purpose — overlay motion is behaviour, not
 * decoration, so `isMotionCalm` does not still it, and a finite animation is
 * what lets an E2E runner's settle wait end anyway.
 */
export const OVERLAY_MOTION = {
	enterMs: 220,
	exitMs: 160,
} as const;

/** Styling for the foundation's own parts. */
export const overlayVariants = tv({
	slots: {
		scrim: "absolute inset-0 bg-overlay",
	},
});

export type OverlayVariantProps = VariantProps<typeof overlayVariants>;
