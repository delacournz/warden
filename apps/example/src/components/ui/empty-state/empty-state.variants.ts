import type { VariantProps } from "tailwind-variants";
import { tv } from "@/lib/tv";

/** How the block sits on the screen: filling its parent, or as a self-contained card. */
export const EMPTY_STATE_VARIANTS = ["default", "card"] as const;

export const EMPTY_STATE_SIZES = ["sm", "md", "lg"] as const;

/** What `EmptyState.Media` draws behind its content: nothing, or a tinted box for a glyph. */
export const EMPTY_STATE_MEDIA_VARIANTS = ["default", "icon"] as const;

export type EmptyStateVariant = (typeof EMPTY_STATE_VARIANTS)[number];
export type EmptyStateSize = (typeof EMPTY_STATE_SIZES)[number];
export type EmptyStateMediaVariant = (typeof EMPTY_STATE_MEDIA_VARIANTS)[number];

/**
 * Theme token an `Icon` composed into `EmptyState.Media` inherits.
 *
 * A colour that reaches an SVG paint prop cannot be a class, so it travels as a
 * token through `IconDefaultsProvider` — the same route `Button` and `ListGroup`
 * use. A bare glyph is `muted-foreground`, because an empty state's picture is
 * decoration and must not outweigh the title. Inside the tinted box it takes
 * full contrast: `muted-foreground` on `bg-muted` is two greys a step apart.
 */
export const EMPTY_STATE_MEDIA_FOREGROUND_TOKEN: Record<EmptyStateMediaVariant, string> = {
	default: "muted-foreground",
	icon: "foreground",
};

/**
 * Styling for every part of an empty state.
 *
 * One slotted `tv()` because size is not decoration here: it drives the
 * padding, both gaps, the media box, the glyph inside it and both type scales.
 * Those belong on one axis rather than in seven numbers that drift apart.
 *
 * `default` uses `grow`, never `flex-1`. `flex-1` is a zero flex basis, so inside
 * a `ScrollView`'s content container — which has no height to grow into — the
 * block would collapse to nothing. `grow` keeps its content height as a floor
 * and fills whatever spare height a bounded parent has, which is what "fills its
 * container" has to mean on both.
 *
 * `card` is a dashed outline on the card surface. The dash is the conventional
 * mark of a slot waiting for content, and it keeps an embedded empty state from
 * reading as one more populated card beside real ones. Its corner follows the
 * card step (`rounded-lg`), stepping down to `rounded-md` at `sm` the way
 * `ListGroup` and `Accordion` do. The border is reserved on both variants, so
 * switching to `card` changes a colour rather than the layout.
 *
 * A size is padding, never a height. The description respects OS font scaling,
 * and a fixed height would clip it at a large accessibility step.
 *
 * The glyph steps with size on the shared icon scale, the same three steps
 * inside the tinted box and out of it — the scale tops out at `icon-2xl`, so a
 * bare glyph a step larger would leave `md` and `lg` identical.
 *
 * The media keeps a bottom margin on top of the header's gap, so the picture
 * clears the title by more than the title clears its description — the two
 * lines read as one unit and the glyph as something above them.
 *
 * No `View` slot carries a `text-*` utility: a React Native `View` does not
 * cascade colour to a `Text` descendant, so colour lives on `title` and
 * `description`, and a glyph's colour on {@link EMPTY_STATE_MEDIA_FOREGROUND_TOKEN}.
 *
 * Free of React Native imports so it stays unit-testable — `bun test` cannot
 * parse React Native's Flow-typed source. See AGENTS.md.
 */
export const emptyStateVariants = tv({
	slots: {
		root: "w-full items-center justify-center border",
		header: "w-full max-w-sm items-center",
		media: "items-center justify-center",
		/** Edge length an `Icon` composed into the media inherits. */
		mediaIcon: "",
		title: "text-center font-semibold text-foreground",
		description: "text-center text-muted-foreground",
		content: "w-full max-w-sm flex-row flex-wrap items-center justify-center",
	},
	variants: {
		variant: {
			default: { root: "grow border-transparent bg-transparent" },
			card: { root: "border-dashed border-border bg-card" },
		},
		size: {
			sm: {
				mediaIcon: "size-icon-lg",
				root: "gap-4 p-4",
				header: "gap-1",
				media: "mb-2",
				title: "text-base",
				description: "text-sm",
				content: "gap-2",
			},
			md: {
				mediaIcon: "size-icon-xl",
				root: "gap-5 p-6",
				header: "gap-1.5",
				media: "mb-3",
				title: "text-lg",
				description: "text-sm",
				content: "gap-2.5",
			},
			lg: {
				mediaIcon: "size-icon-2xl",
				root: "gap-6 p-8",
				header: "gap-2",
				media: "mb-4",
				title: "text-xl",
				description: "text-base",
				content: "gap-3",
			},
		},
		media: {
			default: {},
			icon: { media: "bg-muted" },
		},
	},
	compoundVariants: [
		{ variant: "card", size: "sm", class: { root: "rounded-md" } },
		{ variant: "card", size: ["md", "lg"], class: { root: "rounded-lg" } },
		{ media: "icon", size: "sm", class: { media: "size-10 rounded-md" } },
		{ media: "icon", size: "md", class: { media: "size-12 rounded-lg" } },
		{ media: "icon", size: "lg", class: { media: "size-16 rounded-xl" } },
	],
	defaultVariants: {
		variant: "default",
		size: "md",
		media: "default",
	},
});

export type EmptyStateVariantProps = VariantProps<typeof emptyStateVariants>;
