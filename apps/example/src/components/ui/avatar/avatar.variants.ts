import type { VariantProps } from "tailwind-variants";
import { tv } from "@/lib/tv";

/** How the fallback surface is painted. Orthogonal to {@link AVATAR_COLORS}. */
export const AVATAR_VARIANTS = ["soft", "solid"] as const;

/** What the fallback surface means. The same six a `Badge` takes, so the two pair. */
export const AVATAR_COLORS = ["default", "primary", "success", "warning", "destructive", "info"] as const;

export const AVATAR_SIZES = ["sm", "md", "lg", "xl"] as const;

/** Where an `Avatar.Badge` is pinned. */
export const AVATAR_BADGE_PLACEMENTS = ["top-right", "bottom-right"] as const;

export type AvatarVariant = (typeof AVATAR_VARIANTS)[number];
export type AvatarColor = (typeof AVATAR_COLORS)[number];
export type AvatarSize = (typeof AVATAR_SIZES)[number];
export type AvatarBadgePlacement = (typeof AVATAR_BADGE_PLACEMENTS)[number];

/**
 * A face's edge in points, at each size.
 *
 * The one place a size is a number rather than a class, and it exists because
 * `Avatar.Group` has to compute an overlap: a negative margin set at runtime
 * cannot be a class (Tailwind's scanner is static). A test pins every entry to
 * the `size-*` class the `face` slot resolves to, so the two cannot drift.
 */
export const AVATAR_SIZE_POINTS: Record<AvatarSize, number> = {
	sm: 32,
	md: 40,
	lg: 48,
	xl: 64,
};

/**
 * Theme token that gives the fallback glyph its colour.
 *
 * The avatar's counterpart to `BADGE_FOREGROUND_TOKEN`: a colour that has to
 * reach an SVG paint prop cannot be a class. Every entry names the token the
 * `fallbackLabel` slot resolves to, so initials and the glyph that stands in for
 * them are the same shade — a test asserts the pair.
 */
export const AVATAR_FOREGROUND_TOKEN: Record<AvatarVariant, Record<AvatarColor, string>> = {
	soft: {
		default: "muted-foreground",
		primary: "tertiary-foreground",
		success: "success-soft-foreground",
		warning: "warning-soft-foreground",
		destructive: "destructive-soft-foreground",
		info: "info-soft-foreground",
	},
	solid: {
		default: "secondary-foreground",
		primary: "primary-foreground",
		success: "success-foreground",
		warning: "warning-foreground",
		destructive: "destructive-foreground",
		info: "info-foreground",
	},
};

/**
 * Styling for every part of an avatar, and of a group of them.
 *
 * **The root carries the edge, not `self-start`.** A fixed width and height is
 * something Yoga's `stretch` never overrides, so an avatar in a column keeps its
 * size without the escape hatch `Badge` needs — and, unlike `self-start`, it
 * leaves the parent's own alignment alone. `self-start` pinned every avatar in
 * an `items-end` or `items-center` row to the top of it: mixed sizes lost their
 * baseline and a list row's avatar sat above its text. The face fills the root.
 *
 * **Two boxes, not one.** `root` is unclipped and `face` is the clipped circle
 * inside it. An `Avatar.Badge` hangs over the circle's edge, and a single
 * clipped box would cut it in half; a test asserts `overflow-hidden` is on the
 * face and never on the root.
 *
 * **The fallback is always painted; the image goes on top.** So the fill and
 * the initials show while the image loads and after it fails, and a slow or dead
 * URL never leaves an empty circle.
 *
 * **A size is an edge, and it is a fixed one** — unlike a badge, whose size is
 * padding. A face lines up against other faces in a group and against rows in a
 * list, and must not grow with OS font scaling; the initials are one or two
 * glyphs and are sized to fit the smallest step. {@link AVATAR_SIZE_POINTS} is
 * the same scale as a number, for the group's overlap.
 *
 * **The ring in a group is the page background** — `border-background` on the
 * wrapper around each face, never on the face itself, so a face in a group is the
 * same edge as one outside it and the stack reads as separate people on any
 * surface. The overflow tile sits in the same wrapper for the same reason.
 *
 * **A neutral face has an edge.** `muted` and `secondary` sit a percent or two
 * from the page in light, so a `default` fallback and the `+N` tile draw a
 * hairline `border-border` — inside the box, so no size moves. It goes while a
 * photo is mounted (`hasImage`), because a photo carries its own edge and a
 * grey line around a face reads as a frame.
 *
 * The neutral end of the colour matrix reuses the fills `Badge` does — `muted`
 * and `tertiary` for `soft`, `secondary` for a `solid` default — so an avatar
 * beside a badge of the same colour reads as one family.
 *
 * No view slot holds a `text-*` utility: a React Native `View` does not cascade
 * colour to a `Text` descendant.
 *
 * Free of React Native imports so it stays unit-testable. See AGENTS.md.
 */
export const avatarVariants = tv({
	slots: {
		root: "relative",
		face: "size-full items-center justify-center overflow-hidden rounded-full",
		image: "absolute inset-0",
		fallbackLabel: "text-center font-medium",
		/** Edge length the fallback glyph inherits. */
		icon: "",
		badge: "absolute items-center justify-center",
		dot: "rounded-full border-2 border-background",
		group: "flex-row items-center",
		groupItem: "rounded-full border-2 border-background",
		overflow: "items-center justify-center overflow-hidden rounded-full border border-border bg-muted",
		overflowLabel: "text-center font-medium text-muted-foreground",
	},
	variants: {
		variant: {
			soft: {},
			solid: {},
		},
		// `color` alone paints only the presence dot; the face needs `variant`
		// too, so its twelve cells live in `compoundVariants`.
		color: {
			default: { dot: "bg-muted-foreground" },
			primary: { dot: "bg-primary" },
			success: { dot: "bg-success" },
			warning: { dot: "bg-warning" },
			destructive: { dot: "bg-destructive" },
			info: { dot: "bg-info" },
		},
		size: {
			sm: {
				root: "size-8",
				fallbackLabel: "text-xs",
				icon: "size-icon-sm",
				dot: "size-2.5",
				overflow: "size-8",
				overflowLabel: "text-xs",
			},
			md: {
				root: "size-10",
				fallbackLabel: "text-sm",
				icon: "size-icon-lg",
				dot: "size-3",
				overflow: "size-10",
				overflowLabel: "text-sm",
			},
			lg: {
				root: "size-12",
				fallbackLabel: "text-base",
				icon: "size-icon-xl",
				dot: "size-3.5",
				overflow: "size-12",
				overflowLabel: "text-base",
			},
			xl: {
				root: "size-16",
				fallbackLabel: "text-xl",
				icon: "size-icon-2xl",
				dot: "size-4",
				overflow: "size-16",
				overflowLabel: "text-xl",
			},
		},
		placement: {
			"top-right": { badge: "-top-1 -right-1" },
			"bottom-right": { badge: "-bottom-0.5 -right-0.5" },
		},
		// Whether a photo is mounted over the fallback. Read only by the neutral
		// edge below — a photo carries its own edge.
		hasImage: { true: {}, false: {} },
		// The empty `false` branch is load-bearing typing, not a placeholder.
		// See the note in button.variants.ts.
		isDisabled: { true: { root: "opacity-50" }, false: {} },
	},
	compoundVariants: [
		{ variant: "soft", color: "default", class: { face: "bg-muted", fallbackLabel: "text-muted-foreground" } },
		{ variant: "soft", color: "primary", class: { face: "bg-tertiary", fallbackLabel: "text-tertiary-foreground" } },
		{
			variant: "soft",
			color: "success",
			class: { face: "bg-success-soft", fallbackLabel: "text-success-soft-foreground" },
		},
		{
			variant: "soft",
			color: "warning",
			class: { face: "bg-warning-soft", fallbackLabel: "text-warning-soft-foreground" },
		},
		{
			variant: "soft",
			color: "destructive",
			class: { face: "bg-destructive-soft", fallbackLabel: "text-destructive-soft-foreground" },
		},
		{ variant: "soft", color: "info", class: { face: "bg-info-soft", fallbackLabel: "text-info-soft-foreground" } },

		{
			variant: "solid",
			color: "default",
			class: { face: "bg-secondary", fallbackLabel: "text-secondary-foreground" },
		},
		{ variant: "solid", color: "primary", class: { face: "bg-primary", fallbackLabel: "text-primary-foreground" } },
		{ variant: "solid", color: "success", class: { face: "bg-success", fallbackLabel: "text-success-foreground" } },
		{ variant: "solid", color: "warning", class: { face: "bg-warning", fallbackLabel: "text-warning-foreground" } },
		{
			variant: "solid",
			color: "destructive",
			class: { face: "bg-destructive", fallbackLabel: "text-destructive-foreground" },
		},
		{ variant: "solid", color: "info", class: { face: "bg-info", fallbackLabel: "text-info-foreground" } },

		{ color: "default", hasImage: false, class: { face: "border border-border" } },
	],
	defaultVariants: {
		variant: "soft",
		color: "default",
		size: "md",
		placement: "top-right",
		hasImage: false,
		isDisabled: false,
	},
});

/**
 * An avatar's size: its own, else its group's, else `md`.
 *
 * A group sets the size for every face in it, and a child that states its own
 * still wins — the order a caller reading the JSX would expect.
 */
export function resolveAvatarSize({ size, groupSize }: { size?: AvatarSize; groupSize?: AvatarSize }): AvatarSize {
	return size ?? groupSize ?? "md";
}

/**
 * Points each face in a group slides under the one before it.
 *
 * Defaults to a third of the face's edge, which leaves enough of each face to
 * recognise. An explicit value wins — `0` closes the stack into a plain row —
 * and is clamped between nothing and a whole face, so a typo cannot stack every
 * face on the first or push them apart.
 */
export function resolveAvatarOverlap({ size, overlap }: { size: AvatarSize; overlap?: number }): number {
	const edge = AVATAR_SIZE_POINTS[size];
	if (overlap === undefined || Number.isNaN(overlap)) return Math.round(edge / 3);
	return Math.min(edge, Math.max(0, overlap));
}

/**
 * Whether the root should render as a `Pressable` rather than a plain `View`.
 *
 * The rule `Badge` follows, for the reason it does: an avatar is content until a
 * caller gives it something to do, and a list of fifty should not mount fifty
 * gesture detectors or announce fifty buttons with no action.
 */
export function resolveAvatarInteractive({
	onPress,
	onLongPress,
}: {
	onPress?: () => void;
	onLongPress?: () => void;
}): boolean {
	return onPress !== undefined || onLongPress !== undefined;
}

export type AvatarVariantProps = VariantProps<typeof avatarVariants>;
