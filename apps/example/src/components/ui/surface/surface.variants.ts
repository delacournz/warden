import type { VariantProps } from "tailwind-variants";
import { tv } from "@/lib/tv";

export const SURFACE_VARIANTS = ["default", "secondary", "tertiary", "transparent"] as const;

export const SURFACE_PADDINGS = ["none", "sm", "md", "lg"] as const;

export type SurfaceVariant = (typeof SURFACE_VARIANTS)[number];
export type SurfacePadding = (typeof SURFACE_PADDINGS)[number];

/** The variants that paint a fill — every one but `transparent`. */
export const SURFACE_FILLED_VARIANTS = ["default", "secondary", "tertiary"] as const;

/**
 * A fill something can sit on. `transparent` is not one: it paints nothing, so
 * whatever is inside it still sits on the plane beneath.
 */
export type SurfacePlane = (typeof SURFACE_FILLED_VARIANTS)[number];

/**
 * Theme token for content drawn on each fill — `X-foreground` on an `X`
 * surface, per the package's token rule. A class is `text-${token}`; a value,
 * for an icon or a gradient stop, is `useThemeColor(token)`.
 */
export const SURFACE_FOREGROUND_TOKENS = {
	default: "card-foreground",
	secondary: "secondary-foreground",
	tertiary: "tertiary-foreground",
} as const satisfies Record<SurfacePlane, string>;

/**
 * The fill a nested surface takes when it names none, keyed by the plane it
 * sits on.
 *
 * `tertiary` is quieter than `secondary` — half a step back toward the page —
 * so a third level returns to `secondary` rather than stopping. What matters is
 * that each surface differs from its immediate parent; a strictly ascending
 * ladder would run out of fills at the fourth level and start vanishing into
 * its own parent.
 */
const NEXT_PLANE = {
	default: "secondary",
	secondary: "tertiary",
	tertiary: "secondary",
} as const satisfies Record<SurfacePlane, SurfacePlane>;

/**
 * Styling for a surface.
 *
 * The root is card-shaped — `rounded-lg`, the corner `--radius` names, see the
 * corner-scale note in the package AGENTS.md — with `border-continuous`, which
 * gives iOS's continuous corner rather than a circular arc. Android ignores it.
 *
 * Every variant reserves the same one-point `border`, transparent unless the
 * variant colours it, so changing variant never moves the content. Only
 * `default` colours it: `--card` sits a percent above `--background` in light,
 * and without the hairline a card on a page is white on near-white. The filled
 * rungs below it are told apart by their fill.
 *
 * `padding: "none"` clips, and nothing else does. It is the one step whose
 * content touches the edge — an image or a chart bled to the corners — and that
 * content has to take the corner with it. Clipping everywhere would crop
 * anything a child draws past its own box.
 *
 * No shadow, on purpose. Nothing in this package casts one — React Native's
 * shadow props disagree between platforms — so depth here is carried by fill.
 *
 * The root carries no `text-*`: a React Native `View` does not cascade colour
 * to a `Text` descendant, so a class here would reach nothing.
 *
 * Free of React Native imports so it stays unit-testable — `bun test` cannot
 * parse React Native's Flow-typed source. See AGENTS.md.
 */
export const surfaceVariants = tv({
	slots: {
		root: "rounded-lg border border-continuous border-transparent",
	},
	variants: {
		variant: {
			default: { root: "border-border bg-card" },
			secondary: { root: "bg-secondary" },
			tertiary: { root: "bg-tertiary" },
			transparent: { root: "bg-transparent" },
		},
		padding: {
			none: { root: "overflow-hidden p-0" },
			sm: { root: "p-3" },
			md: { root: "p-4" },
			lg: { root: "p-6" },
		},
	},
	defaultVariants: {
		variant: "default",
		padding: "md",
	},
});

export type SurfaceVariantProps = VariantProps<typeof surfaceVariants>;

/**
 * The fill a surface draws.
 *
 * An explicit `variant` always wins. Without one, a surface at the top of the
 * tree is the `default` card, and a surface nested in another steps to the next
 * fill, so a panel inside a card is told apart from the card with nothing said
 * at the call site — and a `Card` built on this gets the same for free.
 */
export function resolveSurfaceVariant({
	parentPlane,
	variant,
}: {
	parentPlane: SurfacePlane | null;
	variant?: SurfaceVariant;
}): SurfaceVariant {
	if (variant) {
		return variant;
	}
	return parentPlane ? NEXT_PLANE[parentPlane] : "default";
}

/**
 * The plane a surface's children sit on: its own fill, or — for a transparent
 * surface, which paints none — the plane it sits on itself.
 */
export function resolveSurfacePlane({
	parentPlane,
	variant,
}: {
	parentPlane: SurfacePlane | null;
	variant: SurfaceVariant;
}): SurfacePlane | null {
	return variant === "transparent" ? parentPlane : variant;
}
