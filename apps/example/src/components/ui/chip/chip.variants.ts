import type { VariantProps } from "tailwind-variants";
import { tv } from "@/lib/tv";
import {
	BADGE_COLORS,
	BADGE_FOREGROUND_TOKEN,
	BADGE_SIZES,
	type BadgeColor,
	type BadgeSize,
} from "@/components/ui/badge/badge.variants";

/**
 * How an unselected chip is painted.
 *
 * Two of Badge's four, and deliberately not `solid`: a solid fill is what
 * selection paints, so a resting solid chip would read as already selected.
 * `ghost` is left out because a chip with no fill and no border has no edge to
 * aim at.
 */
export const CHIP_VARIANTS = ["soft", "outline"] as const;

/** What the chip means. Badge's list, so a chip and a badge agree on colour. */
export const CHIP_COLORS = BADGE_COLORS;

/** Badge's sizes, so a chip and a badge of one size carry the same glyph. */
export const CHIP_SIZES = BADGE_SIZES;

/**
 * Every surface a chip can wear: its two resting variants, and selection.
 *
 * Selection is a surface rather than a modifier because it replaces the resting
 * paint wholesale — a selected chip looks the same whichever variant it rests on.
 */
export const CHIP_SURFACES = [...CHIP_VARIANTS, "selected"] as const;

export type ChipVariant = (typeof CHIP_VARIANTS)[number];
export type ChipColor = BadgeColor;
export type ChipSize = BadgeSize;
export type ChipSurface = (typeof CHIP_SURFACES)[number];

/**
 * What a chip does when touched — decided by which props it was given.
 *
 * - `static` — a tag. A plain `View`, announced as text.
 * - `button` — `onPress` or `onLongPress`, and no selection.
 * - `toggle` — any selection prop. Announced with its selected state.
 */
export type ChipMode = "static" | "button" | "toggle";

/**
 * Theme token whose value gives an `Icon` composed into the chip its colour.
 *
 * The resting surfaces are Badge's own entries, not copies — a soft `success`
 * chip and a soft `success` badge are the same shade by construction. Only
 * `selected` is new.
 *
 * A selected `default` chip inverts to `foreground`/`background` rather than
 * taking Badge's solid `secondary`: this theme sets `secondary` a hair from
 * `muted`, so a selected default chip would look exactly like a resting one.
 */
export const CHIP_FOREGROUND_TOKEN: Record<ChipSurface, Record<ChipColor, string>> = {
	soft: BADGE_FOREGROUND_TOKEN.soft,
	outline: BADGE_FOREGROUND_TOKEN.outline,
	selected: {
		default: "background",
		primary: "primary-foreground",
		success: "success-foreground",
		warning: "warning-foreground",
		destructive: "destructive-foreground",
		info: "info-foreground",
	},
};

/**
 * Vertical slop that brings the root towards the 44pt minimum touch target.
 *
 * Capped at four points and never horizontal: chips wrap in rows with a
 * `gap-2` between them, and slop past half that gap reaches into the
 * neighbouring chip, making a tap between two of them ambiguous — worse than a
 * target that is merely adequate.
 */
export const CHIP_HIT_SLOP: Record<ChipSize, { top: number; bottom: number; left: number; right: number }> = {
	sm: { top: 4, bottom: 4, left: 0, right: 0 },
	md: { top: 4, bottom: 4, left: 0, right: 0 },
	lg: { top: 2, bottom: 2, left: 0, right: 0 },
};

/**
 * Slop around the close glyph, on every side.
 *
 * The glyph is 14–18 points; this is what makes it something a thumb can find.
 * It reaches into the chip's own padding and past its edge — both are the
 * chip's space, and the inner detector claims the tap before the root sees it.
 */
export const CHIP_CLOSE_HIT_SLOP: Record<ChipSize, number> = { sm: 8, md: 10, lg: 12 };

/**
 * Styling for every part of a chip.
 *
 * Shares Badge's two axes and its tones — a resting chip is painted exactly as
 * the badge of the same variant and colour, a test pins every cell — and adds a
 * third, `isSelected`, which replaces the resting paint with a solid fill in the
 * chip's colour. The selected cells come **after** the resting ones, so
 * tailwind-merge lets them win whatever the chip rests on.
 *
 * `border border-transparent` sits in the base for the reason it does in Badge,
 * with more at stake: a chip toggles in place inside a wrapping row, and a box
 * that grew two points on selection would reflow every chip after it.
 *
 * Padding is a step roomier than Badge at every size — a chip is aimed at, a
 * badge is only read — and still never a height, so the label grows with OS
 * font scaling. The icon step is Badge's, so a glyph moves between the two
 * without changing size.
 *
 * Free of React Native imports so it stays unit-testable. See AGENTS.md.
 */
export const chipVariants = tv({
	slots: {
		root: "flex-row items-center justify-center self-start overflow-hidden rounded-full border border-transparent",
		label: "text-center font-medium",
		startContent: "items-center justify-center",
		endContent: "items-center justify-center",
		closeButton: "items-center justify-center rounded-full",
		/** Edge length an `Icon` composed into the chip inherits. */
		icon: "",
	},
	variants: {
		variant: {
			soft: {},
			outline: { root: "bg-transparent" },
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
				root: "gap-1 px-2.5 py-1",
				label: "text-xs",
				closeButton: "-mr-0.5",
				icon: "size-icon-xs",
			},
			md: {
				root: "gap-1.5 px-3 py-1.5",
				label: "text-sm",
				closeButton: "-mr-1",
				icon: "size-icon-sm",
			},
			lg: {
				root: "gap-2 px-4 py-2",
				label: "text-base",
				closeButton: "-mr-1.5",
				icon: "size-icon-md",
			},
		},
		// The empty `false` branches are load-bearing typing, not placeholders.
		// See the note in button.variants.ts.
		isSelected: { true: {}, false: {} },
		isDisabled: { true: { root: "opacity-50" }, false: {} },
	},
	compoundVariants: [
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

		{
			isSelected: true,
			color: "default",
			class: { root: "border-foreground bg-foreground", label: "text-background" },
		},
		{
			isSelected: true,
			color: "primary",
			class: { root: "border-primary bg-primary", label: "text-primary-foreground" },
		},
		{
			isSelected: true,
			color: "success",
			class: { root: "border-success bg-success", label: "text-success-foreground" },
		},
		{
			isSelected: true,
			color: "warning",
			class: { root: "border-warning bg-warning", label: "text-warning-foreground" },
		},
		{
			isSelected: true,
			color: "destructive",
			class: { root: "border-destructive bg-destructive", label: "text-destructive-foreground" },
		},
		{
			isSelected: true,
			color: "info",
			class: { root: "border-info bg-info", label: "text-info-foreground" },
		},
	],
	defaultVariants: {
		variant: "soft",
		color: "default",
		size: "md",
		isSelected: false,
		isDisabled: false,
	},
});

/**
 * The surface a chip wears — its resting variant, or `selected`.
 *
 * Pure, so the icon colour and the label colour are chosen by one rule that
 * `bun test` reaches. See AGENTS.md.
 */
export function resolveChipSurface({
	variant,
	isSelected,
}: {
	variant: ChipVariant;
	isSelected: boolean;
}): ChipSurface {
	return isSelected ? "selected" : variant;
}

/** The theme token an `Icon` composed into the chip takes its colour from. */
export function resolveChipForegroundToken({
	variant,
	color,
	isSelected,
}: {
	variant: ChipVariant;
	color: ChipColor;
	isSelected: boolean;
}): string {
	return CHIP_FOREGROUND_TOKEN[resolveChipSurface({ isSelected, variant })][color];
}

/**
 * What the root renders as — see {@link ChipMode}.
 *
 * A chip is content until it is given something to do, as a badge is. Any
 * selection prop — `isSelected` even when `false`, `defaultSelected`,
 * `onSelectedChange` — says the chip has an on state, and a screen reader must
 * hear which one it is in, so selection outranks a bare press handler.
 *
 * `onClose` is deliberately not read: the dismiss control is its own
 * pressable, so a chip that can only be removed still has an inert root.
 */
export function resolveChipMode({
	isSelected,
	defaultSelected,
	onSelectedChange,
	onPress,
	onLongPress,
}: {
	isSelected?: boolean;
	defaultSelected?: boolean;
	onSelectedChange?: (isSelected: boolean) => void;
	onPress?: () => void;
	onLongPress?: () => void;
}): ChipMode {
	if (isSelected !== undefined || defaultSelected !== undefined || onSelectedChange !== undefined) return "toggle";
	if (onPress !== undefined || onLongPress !== undefined) return "button";
	return "static";
}

/**
 * How the remove control reaches assistive technology.
 *
 * - `none` — there is no `onClose`.
 * - `element` — a static chip is not an accessibility element itself, so the
 *   close control is announced on its own, as a button.
 * - `action` — a pressable chip is one accessibility element, and iOS folds its
 *   descendants into it: the close control is unreachable by swipe and its
 *   label is read as part of the chip's. It is hidden, and removal is offered as
 *   a `remove` accessibility action on the chip instead — VoiceOver's Actions
 *   rotor, TalkBack's actions menu.
 */
export type ChipCloseExposure = "none" | "element" | "action";

/** See {@link ChipCloseExposure}. Pure, so `bun test` reaches it. */
export function resolveChipCloseExposure({ mode, hasClose }: { mode: ChipMode; hasClose: boolean }): ChipCloseExposure {
	if (!hasClose) return "none";
	return mode === "static" ? "element" : "action";
}

export type ChipVariantProps = VariantProps<typeof chipVariants>;
