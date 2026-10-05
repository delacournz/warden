import type { VariantProps } from "tailwind-variants";
import { tv } from "@/lib/tv";

/** How the surface is painted. Orthogonal to {@link BADGE_COLORS}. */
export const BADGE_VARIANTS = ["solid", "soft", "outline", "ghost"] as const;

/** What the surface means. Orthogonal to {@link BADGE_VARIANTS}. */
export const BADGE_COLORS = ["default", "primary", "success", "warning", "destructive", "info"] as const;

export const BADGE_SIZES = ["sm", "md", "lg"] as const;

export type BadgeVariant = (typeof BADGE_VARIANTS)[number];
export type BadgeColor = (typeof BADGE_COLORS)[number];
export type BadgeSize = (typeof BADGE_SIZES)[number];

/**
 * Theme token whose value gives an `Icon` composed into the badge its colour.
 *
 * The badge's counterpart to `BUTTON_FOREGROUND_TOKEN`, and it exists for the
 * same reason: a colour that has to reach an SVG paint prop cannot be a class.
 * Every entry names the token its own `label` slot resolves to, so a glyph and
 * the text beside it are always the same shade — a test asserts the pair.
 *
 * Nested rather than flattened to twenty-four keys so adding a colour is a
 * compile error in four places instead of a silent gap in one.
 */
export const BADGE_FOREGROUND_TOKEN: Record<BadgeVariant, Record<BadgeColor, string>> = {
	solid: {
		default: "secondary-foreground",
		primary: "primary-foreground",
		success: "success-foreground",
		warning: "warning-foreground",
		destructive: "destructive-foreground",
		info: "info-foreground",
	},
	soft: {
		default: "muted-foreground",
		primary: "tertiary-foreground",
		success: "success-soft-foreground",
		warning: "warning-soft-foreground",
		destructive: "destructive-soft-foreground",
		info: "info-soft-foreground",
	},
	outline: {
		default: "muted-foreground",
		primary: "foreground",
		success: "success-soft-foreground",
		warning: "warning-soft-foreground",
		destructive: "destructive-soft-foreground",
		info: "info-soft-foreground",
	},
	ghost: {
		default: "muted-foreground",
		primary: "foreground",
		success: "success-soft-foreground",
		warning: "warning-soft-foreground",
		destructive: "destructive-soft-foreground",
		info: "info-soft-foreground",
	},
};

/**
 * Styling for every part of a badge.
 *
 * Two axes rather than one. `variant` says how the surface is painted and
 * `color` says what it means, so a caller reaches `soft` + `warning` without the
 * library having to enumerate a `warning-soft` name for it — the combinatorial
 * growth `Button`'s single axis would pay here, where six semantic colours are
 * the point of the component rather than an afterthought. Neither axis carries a
 * surface on its own, so the twenty-four real pairings live in
 * `compoundVariants`.
 *
 * `self-start` is load-bearing. A badge is sized by its content, and inside a
 * gap column every child is stretch-aligned by default — without it, a one-word
 * badge spans the whole screen.
 *
 * `border border-transparent` sits in the base rather than on `outline` alone.
 * A border declared only where it is visible makes the badge two points wider
 * the moment a caller switches variant; reserving it in the box means `outline`
 * changes nothing but the colour.
 *
 * `overflow-hidden` is likewise not tidiness — a pressed badge fades to the
 * edge of its own capsule.
 *
 * A size is padding and never a height. `Text` respects OS font scaling, so a
 * fixed height clips the label at a large accessibility step instead of growing
 * with it, and unlike `h-button-*` a badge lines up against no chrome that would
 * force the number. The icon step indexes the shared `--spacing-icon-*` scale so
 * a glyph in a badge matches every other glyph in the library.
 *
 * The neutral end of the matrix reuses tokens the theme already has instead of
 * minting `--primary-soft`: this theme's `primary` is a near-black, whose
 * tint *is* the neutral fill, so a new token would duplicate `secondary` exactly.
 * `soft` takes `tertiary` for `primary` and `muted` for `default` — two fills the
 * theme already tunes per mode — which keeps all twenty-four cells distinct.
 *
 * The root holds no `text-*` utility: a React Native `View` does not cascade
 * colour to a `Text` descendant, so label colour lives on the `label` slot and
 * icon colour is resolved from {@link BADGE_FOREGROUND_TOKEN}.
 *
 * Free of React Native imports so it stays unit-testable — `bun test` cannot
 * parse React Native's Flow-typed source. See AGENTS.md.
 */
export const badgeVariants = tv({
	slots: {
		root: "flex-row items-center justify-center self-start overflow-hidden rounded-full border border-transparent",
		label: "text-center font-medium",
		startContent: "items-center justify-center",
		endContent: "items-center justify-center",
		closeButton: "items-center justify-center rounded-full",
		/** Edge length an `Icon` composed into the badge inherits. */
		icon: "",
	},
	variants: {
		// Neither axis paints a surface alone — see `compoundVariants`. What
		// each variant does carry is whether the box has a fill at all.
		variant: {
			solid: {},
			soft: {},
			outline: { root: "bg-transparent" },
			ghost: { root: "bg-transparent" },
		},
		color: {
			default: {},
			primary: {},
			success: {},
			warning: {},
			destructive: {},
			info: {},
		},
		size: {
			sm: {
				root: "gap-1 px-2 py-0.5",
				label: "text-xs",
				closeButton: "-mr-0.5",
				icon: "size-icon-xs",
			},
			md: {
				root: "gap-1.5 px-2.5 py-1",
				label: "text-sm",
				closeButton: "-mr-1",
				icon: "size-icon-sm",
			},
			lg: {
				root: "gap-2 px-3 py-1.5",
				label: "text-base",
				closeButton: "-mr-1.5",
				icon: "size-icon-md",
			},
		},
		// The empty `false` branch is load-bearing typing, not a placeholder.
		// See the note in button.variants.ts.
		isDisabled: { true: { root: "opacity-50" }, false: {} },
	},
	compoundVariants: [
		{ variant: "solid", color: "default", class: { root: "bg-secondary", label: "text-secondary-foreground" } },
		{ variant: "solid", color: "primary", class: { root: "bg-primary", label: "text-primary-foreground" } },
		{ variant: "solid", color: "success", class: { root: "bg-success", label: "text-success-foreground" } },
		{ variant: "solid", color: "warning", class: { root: "bg-warning", label: "text-warning-foreground" } },
		{ variant: "solid", color: "destructive", class: { root: "bg-destructive", label: "text-destructive-foreground" } },
		{ variant: "solid", color: "info", class: { root: "bg-info", label: "text-info-foreground" } },

		{ variant: "soft", color: "default", class: { root: "bg-muted", label: "text-muted-foreground" } },
		{ variant: "soft", color: "primary", class: { root: "bg-tertiary", label: "text-tertiary-foreground" } },
		{
			variant: "soft",
			color: "success",
			class: { root: "bg-success-soft", label: "text-success-soft-foreground" },
		},
		{
			variant: "soft",
			color: "warning",
			class: { root: "bg-warning-soft", label: "text-warning-soft-foreground" },
		},
		{
			variant: "soft",
			color: "destructive",
			class: { root: "bg-destructive-soft", label: "text-destructive-soft-foreground" },
		},
		{ variant: "soft", color: "info", class: { root: "bg-info-soft", label: "text-info-soft-foreground" } },

		{ variant: "outline", color: "default", class: { root: "border-border", label: "text-muted-foreground" } },
		{ variant: "outline", color: "primary", class: { root: "border-primary", label: "text-foreground" } },
		{
			variant: "outline",
			color: "success",
			class: { root: "border-success", label: "text-success-soft-foreground" },
		},
		{
			variant: "outline",
			color: "warning",
			class: { root: "border-warning", label: "text-warning-soft-foreground" },
		},
		{
			variant: "outline",
			color: "destructive",
			class: { root: "border-destructive", label: "text-destructive-soft-foreground" },
		},
		{ variant: "outline", color: "info", class: { root: "border-info", label: "text-info-soft-foreground" } },

		{ variant: "ghost", color: "default", class: { label: "text-muted-foreground" } },
		{ variant: "ghost", color: "primary", class: { label: "text-foreground" } },
		{ variant: "ghost", color: "success", class: { label: "text-success-soft-foreground" } },
		{ variant: "ghost", color: "warning", class: { label: "text-warning-soft-foreground" } },
		{ variant: "ghost", color: "destructive", class: { label: "text-destructive-soft-foreground" } },
		{ variant: "ghost", color: "info", class: { label: "text-info-soft-foreground" } },
	],
	defaultVariants: {
		variant: "solid",
		color: "default",
		size: "md",
		isDisabled: false,
	},
});

/**
 * Whether the root should render as a `Pressable` rather than a plain `View`.
 *
 * A badge is content until a caller gives it something to do. Mounting a
 * `GestureDetector` regardless would put one under every tag in a list of fifty
 * and announce each of them to assistive technology as a button with no action.
 *
 * `onClose` is deliberately not read here: the dismiss control is its own
 * pressable, so a badge that can only be dismissed still has an inert root.
 *
 * Pure, so the matrix is reachable from `bun test`. See AGENTS.md.
 */
export function resolveBadgeInteractive({
	onPress,
	onLongPress,
}: {
	onPress?: () => void;
	onLongPress?: () => void;
}): boolean {
	return onPress !== undefined || onLongPress !== undefined;
}

export type BadgeVariantProps = VariantProps<typeof badgeVariants>;
