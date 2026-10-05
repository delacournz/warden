import { Children, type ReactNode } from "react";
import type { VariantProps } from "tailwind-variants";
import { tv } from "@/lib/tv";
import { resolveSurfaceVariant, type SurfacePlane } from "@/components/ui/surface/surface.variants";

export const CARD_SIZES = ["sm", "md", "lg"] as const;

/** `default` is a row of actions; `band` sets the footer into the card as a strip of its own. */
export const CARD_FOOTER_VARIANTS = ["default", "band"] as const;

/**
 * The planes a card's title can sit on: the three surface fills, plus `none`
 * for a transparent card on the page, which has no fill of its own.
 */
export const CARD_PLANES = ["default", "secondary", "tertiary", "none"] as const;

export type CardSize = (typeof CARD_SIZES)[number];
export type CardFooterVariant = (typeof CARD_FOOTER_VARIANTS)[number];
export type CardPlane = (typeof CARD_PLANES)[number];

/**
 * Styling for every part of a card.
 *
 * The card's own surface — fill, hairline, corner, clip — is `Surface`'s, at
 * `padding="none"`. What this adds is the rhythm between the parts, and it
 * puts the padding on the PARTS rather than on the root. The root holds only
 * `pt`/`pb` and a `gap` of the same step; the header, content and footer each
 * carry the same step as `px`. So an image placed straight in the card reaches
 * both side edges with nothing to undo, and `className="pt-0"` on the card is
 * all it takes to bleed one to the top as well.
 *
 * `pt`/`pb` rather than `py`, and that is load-bearing: the root is also the
 * surface's, which carries `p-0` at `padding="none"`, and Uniwind resolves that
 * shorthand over a `py-*` on the same view. The card rendered with no vertical
 * padding at all until the longhands replaced it.
 *
 * Size is one axis for five numbers — the vertical padding, the gap, the
 * horizontal inset and the title and description type scale — and the steps
 * are Surface's own `sm`/`md`/`lg` (3, 4, 6), so a card and a surface beside
 * it at the same size hold their content at the same distance from the edge.
 *
 * The title colour is keyed on `plane`, the fill the card resolved to, so a
 * card nested in another reads `text-secondary-foreground` on the secondary
 * fill rather than the card's token on something else. The classes are written
 * out per plane because Tailwind's scanner cannot see a `text-${token}` built at
 * runtime.
 *
 * A `band` footer is set INTO the card: `-mb-*` pulls it down over the root's
 * bottom padding by exactly that padding and `py-*` restates it inside, so it
 * meets the card's bottom edge — the root clips, so it takes the card's own
 * corners — while its content keeps the same breathing room. Its fill is the
 * next rung of the surface ladder from the card's, see
 * {@link resolveCardFooterFill}.
 *
 * The root, header, content and footer carry no `text-*` (rule 1): a `View`
 * does not cascade colour to a `Text`, so the tokens live on the title and
 * description slots.
 *
 * Free of React Native imports so it stays unit-testable — `bun test` cannot
 * parse React Native's Flow-typed source. See AGENTS.md.
 */
export const cardVariants = tv({
	slots: {
		root: "",
		header: "flex-row items-start gap-3",
		/** The column holding the title and description, beside any action. */
		headerText: "flex-1",
		action: "shrink-0 flex-row items-center self-start",
		title: "font-semibold",
		description: "text-muted-foreground",
		content: "",
		footer: "flex-row flex-wrap items-center gap-2",
	},
	variants: {
		size: {
			sm: {
				root: "gap-3 pt-3 pb-3",
				header: "px-3",
				headerText: "gap-0.5",
				content: "gap-2 px-3",
				footer: "px-3",
				title: "text-sm",
				description: "text-xs",
			},
			md: {
				root: "gap-4 pt-4 pb-4",
				header: "px-4",
				headerText: "gap-1",
				content: "gap-3 px-4",
				footer: "px-4",
				title: "text-base",
				description: "text-sm",
			},
			lg: {
				root: "gap-6 pt-6 pb-6",
				header: "px-6",
				headerText: "gap-1.5",
				content: "gap-4 px-6",
				footer: "px-6",
				title: "text-lg",
				description: "text-base",
			},
		},
		plane: {
			default: { title: "text-card-foreground" },
			secondary: { title: "text-secondary-foreground" },
			tertiary: { title: "text-tertiary-foreground" },
			none: { title: "text-foreground" },
		},
		footer: {
			default: {},
			band: { footer: "border-t border-border" },
		},
		// Read only by a band; the plain footer paints nothing whatever this is.
		footerFill: {
			default: {},
			secondary: {},
			tertiary: {},
		},
	},
	compoundVariants: [
		{ footer: "band", size: "sm", class: { footer: "-mb-3 py-3" } },
		{ footer: "band", size: "md", class: { footer: "-mb-4 py-4" } },
		{ footer: "band", size: "lg", class: { footer: "-mb-6 py-6" } },
		{ footer: "band", footerFill: "default", class: { footer: "bg-card" } },
		{ footer: "band", footerFill: "secondary", class: { footer: "bg-secondary" } },
		{ footer: "band", footerFill: "tertiary", class: { footer: "bg-tertiary" } },
	],
	defaultVariants: {
		size: "md",
		plane: "default",
		footer: "default",
		footerFill: "secondary",
	},
});

export type CardVariantProps = VariantProps<typeof cardVariants>;

/**
 * The fill a `band` footer paints: the next rung of the surface ladder from the
 * card's own, so the band is always told apart from the card it is set into.
 *
 * It is the same step a surface nested in the card would take, which is the
 * point — a band is the card's plane stepped once, not a colour of its own. A
 * transparent card on the page has no plane, so its band takes the card fill.
 */
export function resolveCardFooterFill(plane: SurfacePlane | null): SurfacePlane {
	const next = resolveSurfaceVariant({ parentPlane: plane });
	return next === "transparent" ? "default" : next;
}

/**
 * Splits a header's children into its text column and its trailing actions.
 *
 * A header is a row — the title and description stacked on the left, an action
 * pinned to the top right — and React Native has no grid to place a child by
 * type. So the header walks its children and lifts every action out, keeping
 * the rest in order for the column. `Children.toArray` drops the nulls and
 * booleans a conditional child leaves behind, so an action rendered only some
 * of the time does not leave a hole in either list.
 *
 * `isAction` is passed in rather than imported so this stays free of the part
 * it looks for, and of React Native with it.
 */
export function splitCardHeaderChildren(
	children: ReactNode,
	isAction: (node: ReactNode) => boolean
): { text: ReactNode[]; actions: ReactNode[] } {
	const text: ReactNode[] = [];
	const actions: ReactNode[] = [];

	for (const child of Children.toArray(children)) {
		(isAction(child) ? actions : text).push(child);
	}

	return { actions, text };
}
