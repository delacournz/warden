import type { VariantProps } from "tailwind-variants";
import { tv } from "@/lib/tv";
import type { PressableFeedback } from "@/components/ui/pressable/pressable.variants";

export const ITEM_VARIANTS = ["default", "outline", "muted"] as const;

export const ITEM_SIZES = ["sm", "md", "lg"] as const;

export const ITEM_ORIENTATIONS = ["horizontal", "vertical"] as const;

export const ITEM_MEDIA_VARIANTS = ["default", "icon", "image"] as const;

export type ItemVariant = (typeof ITEM_VARIANTS)[number];
export type ItemSize = (typeof ITEM_SIZES)[number];
export type ItemOrientation = (typeof ITEM_ORIENTATIONS)[number];
export type ItemMediaVariant = (typeof ITEM_MEDIA_VARIANTS)[number];

/**
 * The surface a row actually draws.
 *
 * One of the three variants a caller picks, or `grouped` — the surface an item
 * takes inside a `ListGroup`, where the group already draws the card and the
 * row must draw nothing but itself.
 */
export type ItemSurface = ItemVariant | "grouped";

/** Theme token an icon in `Item.Media` inherits. */
export const ITEM_MEDIA_ICON_TOKEN = "foreground";

/** Theme token an icon in `Item.Actions` inherits — a trailing hint, not the row's subject. */
export const ITEM_ACTIONS_ICON_TOKEN = "muted-foreground";

/**
 * The surface an item draws, given its variant and whether a `ListGroup`
 * encloses it.
 *
 * Inside a group the variant is ignored: the group owns the border, the fill
 * and the corner, and a row repeating any of them would draw a card inside a
 * card.
 */
export function resolveItemSurface(variant: ItemVariant, isInGroup: boolean): ItemSurface {
	return isInGroup ? "grouped" : variant;
}

/**
 * An item's size: its own when set, else the enclosing `ListGroup`'s, else
 * `md`.
 *
 * The two share one scale on purpose, so an item dropped into a `sm` group
 * comes out `sm` with nothing said at the call site.
 */
export function resolveItemSize(size: ItemSize | undefined, groupSize: ItemSize | undefined): ItemSize {
	return size ?? groupSize ?? "md";
}

/**
 * The press feedback for an item, when the caller has not named one.
 *
 * A full-bleed row inside a group fades, because a row that scales reads as
 * the whole card flexing. A standalone item is its own card, so it scales the
 * way a card does.
 */
export function resolveItemFeedback(feedback: PressableFeedback | undefined, isInGroup: boolean): PressableFeedback {
	return feedback ?? (isInGroup ? "fade" : "scale");
}

/**
 * What an item renders as.
 *
 * - `pressable` — it has a handler: a `Pressable`, announced as a button. A
 *   disabled one keeps the role, reports `disabled`, and dims through
 *   `opacity-50`, which `Pressable` composes with its press animation.
 * - `static` — no handler: a plain view with no role. A static row announcing
 *   itself as a button is a lie VoiceOver tells on every swipe.
 */
export type ItemRender = "pressable" | "static";

export function resolveItemRender(options: {
	onPress?: () => void;
	onLongPress?: () => void;
	isDisabled: boolean;
}): ItemRender {
	const hasHandler = options.onPress !== undefined || options.onLongPress !== undefined;
	return hasHandler ? "pressable" : "static";
}

/**
 * Styling for every part of an item.
 *
 * Row metrics are the same numbers a `ListGroup` row uses, per size — asserted
 * as a pair in the tests — because a group insets its dividers by its own row
 * padding. An item whose padding drifted from that would sit in a group with
 * its text and its divider out of line.
 *
 * `surface` rather than `variant` is the axis here, because inside a group the
 * variant a caller passed does not decide what is drawn. `resolveItemSurface`
 * is where that decision lives.
 *
 * The horizontal root wraps, and `header` and `footer` are `w-full`: a strip
 * then takes a line of its own above or below the media, text and actions, on
 * either orientation, with no extra prop. `content` only flexes along a row — a
 * `flex-1` column in an auto-height parent collapses to nothing in Yoga.
 *
 * No slot but the two text slots holds a `text-*` colour — a React Native
 * `View` does not cascade one to a `Text`.
 *
 * Free of React Native imports so it stays unit-testable — `bun test` cannot
 * parse React Native's Flow-typed source. See AGENTS.md.
 */
export const itemVariants = tv({
	slots: {
		root: "",
		media: "items-center justify-center",
		/** Edge length an `Icon` in the media slot inherits. */
		mediaIcon: "",
		content: "justify-center gap-0.5",
		title: "font-medium text-foreground",
		description: "text-muted-foreground",
		actions: "flex-row items-center gap-2",
		/** Edge length an `Icon` in the actions slot inherits. */
		actionsIcon: "",
		header: "w-full flex-row items-center justify-between gap-2",
		footer: "w-full flex-row items-center justify-between gap-2",
		group: "",
	},
	variants: {
		surface: {
			default: { root: "rounded-lg border border-transparent bg-transparent" },
			outline: { root: "rounded-lg border border-border bg-transparent" },
			muted: { root: "rounded-lg border border-transparent bg-muted" },
			grouped: { root: "w-full bg-transparent" },
		},
		size: {
			sm: {
				root: "min-h-12 gap-2.5 px-3 py-2",
				title: "text-sm",
				description: "text-xs",
				actionsIcon: "size-icon-xs",
			},
			md: {
				root: "min-h-14 gap-3 px-4 py-3",
				title: "text-base",
				description: "text-sm",
				actionsIcon: "size-icon-sm",
			},
			lg: {
				root: "min-h-16 gap-3.5 px-5 py-4",
				title: "text-lg",
				description: "text-base",
				actionsIcon: "size-icon-md",
			},
		},
		orientation: {
			horizontal: { root: "flex-row flex-wrap items-center", content: "flex-1" },
			vertical: { root: "flex-col items-start", content: "self-stretch" },
		},
		mediaVariant: {
			default: {},
			icon: { media: "rounded-md bg-muted" },
			image: { media: "overflow-hidden rounded-md bg-muted" },
		},
		groupOrientation: {
			vertical: { group: "flex-col gap-2" },
			horizontal: { group: "flex-row gap-3" },
		},
		// The empty `false` branches type the props as `boolean` rather than
		// `true`. See the note in button.variants.ts.
		isDisabled: { true: { root: "opacity-50" }, false: {} },
		isSelected: { true: { root: "bg-accent" }, false: {} },
	},
	compoundVariants: [
		// A card-shaped surface is `rounded-lg`, stepping down to `rounded-md` at
		// `sm` — the same one step `ListGroup` and `Accordion` take.
		{ size: "sm", surface: ["default", "outline", "muted"], class: { root: "rounded-md" } },
		{ mediaVariant: "default", size: "sm", class: { mediaIcon: "size-icon-md" } },
		{ mediaVariant: "default", size: "md", class: { mediaIcon: "size-icon-lg" } },
		{ mediaVariant: "default", size: "lg", class: { mediaIcon: "size-icon-xl" } },
		{ mediaVariant: "icon", size: "sm", class: { media: "size-8", mediaIcon: "size-icon-sm" } },
		{ mediaVariant: "icon", size: "md", class: { media: "size-10", mediaIcon: "size-icon-md" } },
		{ mediaVariant: "icon", size: "lg", class: { media: "size-12", mediaIcon: "size-icon-lg" } },
		{ mediaVariant: "image", size: "sm", class: { media: "size-10" } },
		{ mediaVariant: "image", size: "md", class: { media: "size-12" } },
		{ mediaVariant: "image", size: "lg", class: { media: "size-14" } },
		// A tile is `bg-muted`, so on a muted or selected surface it would vanish
		// into the row.
		{ mediaVariant: ["icon", "image"], surface: "muted", class: { media: "bg-background" } },
		{ mediaVariant: ["icon", "image"], isSelected: true, class: { media: "bg-background" } },
	],
	defaultVariants: {
		surface: "default",
		size: "md",
		orientation: "horizontal",
		mediaVariant: "default",
		groupOrientation: "vertical",
		isDisabled: false,
		isSelected: false,
	},
});

export type ItemVariantProps = VariantProps<typeof itemVariants>;
