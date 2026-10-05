import type { VariantProps } from "tailwind-variants";
import { tv } from "@/lib/tv";

export const LIST_GROUP_VARIANTS = ["default", "secondary", "tertiary", "transparent"] as const;

export const LIST_GROUP_SIZES = ["sm", "md", "lg"] as const;

export type ListGroupVariant = (typeof LIST_GROUP_VARIANTS)[number];
export type ListGroupSize = (typeof LIST_GROUP_SIZES)[number];

/** Theme token an icon in `ListGroup.ItemPrefix` inherits. */
export const LIST_GROUP_FOREGROUND_TOKEN = "foreground";

/** Theme token the default trailing chevron inherits. */
export const LIST_GROUP_SUFFIX_ICON_TOKEN = "muted-foreground";

/**
 * Styling for every part of a list group.
 *
 * Both icon slots name a step on the shared `--spacing-icon-*` scale, the same
 * one `Icon` and `Spinner` use, so a row's glyph lines up with every other glyph
 * in the library rather than carrying a private number.
 *
 * One slotted `tv()` rather than a call per part, because size is not
 * decoration here: it drives the row metrics, the title and description type
 * scale, both icon sizes *and* the divider inset. Those five belong on one axis
 * rather than in five places that can drift apart — the divider inset tracking
 * the row's padding is asserted as a pair in the tests for exactly that reason.
 *
 * `overflow-hidden` on the root is load-bearing rather than tidiness: a pressed
 * row fades to the edge of its own box, and the first and last rows would square
 * off the group's corners without it.
 *
 * The root and item slots hold no `text-*` utility — a React Native `View` does
 * not cascade colour to a `Text` descendant, so the text tokens live on the
 * title and description slots.
 *
 * `w-full` on the item matters because the root clips: without it a short row
 * leaves the press feedback ending mid-card instead of spanning it.
 *
 * Free of React Native imports so it stays unit-testable — `bun test` cannot
 * parse React Native's Flow-typed source. See AGENTS.md.
 */
export const listGroupVariants = tv({
	slots: {
		root: "overflow-hidden border border-transparent",
		item: "w-full flex-row items-center",
		/** Positioning only for a divider the root inserts — the line is a `Separator`. */
		divider: "",
		prefix: "items-center justify-center",
		/** Edge length an `Icon` in the prefix inherits. */
		prefixIcon: "",
		content: "flex-1 justify-center gap-0.5",
		title: "font-medium text-foreground",
		description: "text-muted-foreground",
		suffix: "items-center justify-center",
		/** Edge length of the default trailing chevron. */
		suffixIcon: "",
	},
	variants: {
		variant: {
			default: { root: "border-border bg-card" },
			secondary: { root: "bg-secondary" },
			tertiary: { root: "bg-tertiary" },
			transparent: { root: "bg-transparent" },
		},
		size: {
			sm: {
				root: "rounded-md",
				item: "min-h-12 gap-2.5 px-3 py-2",
				divider: "mx-3",
				prefixIcon: "size-icon-md",
				suffixIcon: "size-icon-xs",
				title: "text-sm",
				description: "text-xs",
			},
			md: {
				root: "rounded-md",
				item: "min-h-14 gap-3 px-4 py-3",
				divider: "mx-4",
				prefixIcon: "size-icon-lg",
				suffixIcon: "size-icon-sm",
				title: "text-base",
				description: "text-sm",
			},
			lg: {
				root: "rounded-md",
				item: "min-h-16 gap-3.5 px-5 py-4",
				divider: "mx-5",
				prefixIcon: "size-icon-xl",
				suffixIcon: "size-icon-md",
				title: "text-lg",
				description: "text-base",
			},
		},
		// The empty `false` branch types the prop as `boolean` rather than `true`.
		// See the note in button.variants.ts.
		isDisabled: { true: { item: "opacity-50" }, false: {} },
	},
	defaultVariants: {
		variant: "default",
		size: "md",
		isDisabled: false,
	},
});

export type ListGroupVariantProps = VariantProps<typeof listGroupVariants>;
