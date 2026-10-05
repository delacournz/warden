import type { VariantProps } from "tailwind-variants";
import { tv } from "@/lib/tv";
import type { SurfacePadding, SurfaceVariant } from "@/components/ui/surface/surface.variants";

/** What the alert says about the thing it describes. */
export const ALERT_STATUSES = ["default", "info", "success", "warning", "destructive"] as const;

/** The statuses that carry a colour — every one but `default`. */
export const ALERT_TINTED_STATUSES = ["info", "success", "warning", "destructive"] as const;

/**
 * How the surface is painted. `soft` washes it in the status's soft fill;
 * `surface` keeps the neutral fill the surface ladder gives it and colours only
 * the indicator and the title.
 */
export const ALERT_VARIANTS = ["soft", "surface"] as const;

export const ALERT_SIZES = ["sm", "md", "lg"] as const;

export type AlertStatus = (typeof ALERT_STATUSES)[number];
export type AlertVariant = (typeof ALERT_VARIANTS)[number];
export type AlertSize = (typeof ALERT_SIZES)[number];

/**
 * Theme token for the indicator's glyph and the title's colour.
 *
 * One token per status, not per status and variant: `X-soft-foreground` is
 * tuned to read on `X-soft` and on the neutral fills alike, so the same shade
 * holds on both variants. A test pins each entry to the class the `title` slot
 * emits, so the glyph and the words beside it cannot drift apart.
 */
export const ALERT_FOREGROUND_TOKEN = {
	default: "foreground",
	info: "info-soft-foreground",
	success: "success-soft-foreground",
	warning: "warning-soft-foreground",
	destructive: "destructive-soft-foreground",
} as const satisfies Record<AlertStatus, string>;

/** The surface's padding step for each alert size. */
export const ALERT_SURFACE_PADDING = {
	sm: "sm",
	md: "md",
	lg: "lg",
} as const satisfies Record<AlertSize, SurfacePadding>;

/**
 * Styling for every part of an alert.
 *
 * The root is laid over a `Surface`, which owns the corner, the padding and —
 * unless the alert is tinted — the fill. This `tv()` adds only what an alert
 * has and a surface does not: the row, the tint and the text treatment.
 *
 * A tinted alert (`soft`, with a status) swaps the card's fill for the status's
 * soft fill and clears the card's hairline. A grey hairline around a red wash
 * reads as two components stacked; the wash is its own edge. Everything else
 * names no background, so the surface ladder picks one and an alert inside a
 * card steps off the card rather than vanishing into it.
 *
 * `items-start`, not `items-center`: a description that wraps to four lines
 * must not drag the glyph down to its middle. The indicator instead carries the
 * title's line height as its own height and centres the glyph in it, which
 * puts the glyph level with the first line at every size.
 *
 * No slot carries a fixed height apart from that indicator — `Text` respects OS
 * font scaling, and a fixed box would clip a wrapped title.
 *
 * The root holds no `text-*` (rule 1). The title takes its status's colour,
 * the description is always muted, so a long explanation never shouts.
 *
 * Free of React Native imports so it stays unit-testable — `bun test` cannot
 * parse React Native's Flow-typed source. See AGENTS.md.
 */
export const alertVariants = tv({
	slots: {
		root: "flex-row items-start",
		indicator: "items-center justify-center",
		content: "min-w-0 flex-1 gap-1",
		title: "font-semibold",
		description: "text-muted-foreground",
		action: "mt-2 flex-row flex-wrap items-center gap-2",
		closeButton: "items-center justify-center rounded-full",
		/** Edge length an `Icon` composed into the alert inherits. */
		icon: "",
	},
	variants: {
		variant: {
			soft: {},
			surface: {},
		},
		// Written out rather than built from `ALERT_FOREGROUND_TOKEN`: Tailwind's
		// scanner is static, and a class assembled at runtime is never compiled.
		status: {
			default: { title: "text-foreground" },
			info: { title: "text-info-soft-foreground" },
			success: { title: "text-success-soft-foreground" },
			warning: { title: "text-warning-soft-foreground" },
			destructive: { title: "text-destructive-soft-foreground" },
		},
		size: {
			sm: {
				root: "gap-2",
				indicator: "h-5",
				title: "text-sm",
				description: "text-xs",
				closeButton: "size-5",
				icon: "size-icon-sm",
			},
			md: {
				root: "gap-3",
				indicator: "h-6",
				title: "text-base",
				description: "text-sm",
				closeButton: "size-6",
				icon: "size-icon-md",
			},
			lg: {
				root: "gap-3.5",
				indicator: "h-7",
				title: "text-lg",
				description: "text-base",
				closeButton: "size-7",
				icon: "size-icon-lg",
			},
		},
	},
	compoundVariants: [
		{ variant: "soft", status: "info", class: { root: "border-transparent bg-info-soft" } },
		{ variant: "soft", status: "success", class: { root: "border-transparent bg-success-soft" } },
		{ variant: "soft", status: "warning", class: { root: "border-transparent bg-warning-soft" } },
		{ variant: "soft", status: "destructive", class: { root: "border-transparent bg-destructive-soft" } },
	],
	defaultVariants: {
		variant: "soft",
		status: "default",
		size: "md",
	},
});

export type AlertVariantProps = VariantProps<typeof alertVariants>;

/**
 * Whether the alert paints its status's soft fill over the surface.
 *
 * Only a `soft` alert with a status is: a neutral alert has no tint to paint,
 * and a `surface` alert keeps the ladder's fill on purpose.
 */
export function resolveAlertTinted({ status, variant }: { status: AlertStatus; variant: AlertVariant }): boolean {
	return variant === "soft" && status !== "default";
}

/**
 * The `variant` the alert hands its `Surface`.
 *
 * A tinted alert pins it to `default`: the tint replaces the fill, and what
 * nests inside then steps from the card like anything else on one. Every other
 * alert leaves it `undefined`, so the surface reads the plane it sits on and
 * steps to the next fill — an alert inside a card is told apart from the card
 * with nothing said at the call site.
 */
export function resolveAlertSurfaceVariant({
	status,
	variant,
}: {
	status: AlertStatus;
	variant: AlertVariant;
}): SurfaceVariant | undefined {
	return resolveAlertTinted({ status, variant }) ? "default" : undefined;
}

/**
 * How urgently Android's TalkBack announces a change inside the alert.
 *
 * A warning or a failure interrupts whatever is being read; anything else waits
 * its turn. iOS has no live regions — the root's `alert` role is what VoiceOver
 * reads there.
 */
export function resolveAlertLiveRegion(status: AlertStatus): "polite" | "assertive" {
	return status === "destructive" || status === "warning" ? "assertive" : "polite";
}
