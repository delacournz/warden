import { cn } from "@/lib/cn";
import { tv } from "@/lib/tv";

export const ICON_SIZES = ["xs", "sm", "md", "lg", "xl", "2xl"] as const;

export type IconSize = (typeof ICON_SIZES)[number];

/**
 * Edge length for each named icon size, as a token class rather than a number.
 *
 * The steps come from the `--spacing-icon-*` scale in `tokens.css`, which
 * `Spinner` names identically — so `size="md"` is the same edge length in both
 * and one can replace the other without the layout moving. A control's own size
 * axis indexes into the same scale rather than restating a number.
 *
 * A className can never size a Central Icon through a style. `CentralIconBase`
 * spreads its props onto `<Svg>` *before* its own `width`/`height`, and
 * `Svg.render` then pushes the width/height-derived styles onto the root last,
 * where they beat anything a className contributed. So the size has to arrive as
 * the `size` **prop** — `Icon` runs this class through `withUniwind` to recover
 * the width and hands that to the glyph. See `icon.tsx`.
 *
 * No `defaultVariants` on purpose. The fallback has to *lose* to an inherited
 * class, and a default here would emit from inside this same call, ahead of it
 * in the merge. {@link resolveIconSizeClass} orders the sources instead.
 *
 * Free of React Native imports so it stays unit-testable — `bun test` cannot
 * parse React Native's Flow-typed source. See AGENTS.md.
 */
export const iconVariants = tv({
	variants: {
		size: {
			xs: "size-icon-xs",
			sm: "size-icon-sm",
			md: "size-icon-md",
			lg: "size-icon-lg",
			xl: "size-icon-xl",
			"2xl": "size-icon-2xl",
		},
	},
});

/** Edge length used with no `size`, no `className` and nothing to inherit — 20pt. */
export const ICON_FALLBACK_SIZE_CLASS = "size-icon-lg";

/** Theme token used with no `color` prop and nothing to inherit from. */
export const ICON_FALLBACK_COLOR = "foreground";

/** Whether a size is one of the named steps rather than an edge length in points. */
export function isIconSize(size: IconSize | number | undefined): size is IconSize {
	return typeof size === "string";
}

/**
 * The class chain that sizes an icon, weakest source first: the fallback, the
 * enclosing component's class, this icon's named size, then the caller's own
 * className. `cn` resolves the conflicts, so the last `size-*` wins.
 *
 * A numeric `size` is deliberately absent. It is not a class — it goes straight
 * to the glyph's prop, and uniwind then skips its mapping because that prop is
 * already defined. That skip *is* the precedence rule.
 *
 * Note for callers overriding through `className`: use `size-*`, not `w-*` with
 * `h-*`. tailwind-merge conflicts `size` into `w`/`h` but not the reverse, so a
 * trailing `w-6` will not clear a leading `size-5`.
 *
 * Pure, so the whole ladder is reachable from `bun test`. See AGENTS.md.
 */
export function resolveIconSizeClass({
	size,
	inherited,
	className,
}: {
	size?: IconSize | number;
	inherited?: string;
	className?: string;
}): string {
	return cn(ICON_FALLBACK_SIZE_CLASS, inherited, isIconSize(size) ? iconVariants({ size }) : undefined, className);
}
