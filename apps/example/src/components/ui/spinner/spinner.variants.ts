import { cn } from "@/lib/cn";
import { tv } from "@/lib/tv";
import { ICON_SIZES, type IconSize } from "@/components/ui/icon/icon.variants";

/**
 * The spinner's named sizes *are* the icon's.
 *
 * A spinner is a glyph that stands in for an icon — inside a button it replaces
 * one outright — so the two have to mean the same thing by `size="md"`. Sharing
 * the scale makes that structural instead of two lists that have to be kept in
 * step. A leaf import, so no cycle: see AGENTS.md rule 3.
 */
export const SPINNER_SIZES = ICON_SIZES;
export const SPINNER_COLORS = ["default", "success", "warning", "destructive"] as const;

export type SpinnerSize = IconSize;
export type SpinnerColor = (typeof SPINNER_COLORS)[number];

/** Theme token behind each named colour. */
export const SPINNER_COLOR_TOKEN: Record<SpinnerColor, string> = {
	default: "foreground",
	success: "success",
	warning: "warning",
	destructive: "destructive",
};

/** One full turn, in milliseconds, at speed 1. */
export const SPINNER_DURATION_MS = 900;

/**
 * Stroke width of the default arc, in viewBox units.
 *
 * The head cap is a circle of half this radius, so the two cannot be tuned
 * apart — see `spinner-arc.tsx` for why the head is drawn separately at all.
 */
export const SPINNER_ARC_STROKE_WIDTH = 2.5;

/** Alpha at the comet's head, and at the far end of its tail. */
export const SPINNER_ARC_HEAD_OPACITY = 1;
export const SPINNER_ARC_TAIL_OPACITY = 0;

/**
 * Alpha where the two half-rings meet, opposite the head.
 *
 * Derived, never picked. Each half is a straight ramp, so the joint has to be
 * the midpoint of the two ends or the ramps meet at different slopes and crease
 * the ring — a soft bright wedge on one side of the joint, visible even though
 * the alpha itself is continuous there. Held at 0.55 for a while, which is what
 * that crease was.
 */
export const SPINNER_ARC_JOINT_OPACITY = (SPINNER_ARC_HEAD_OPACITY + SPINNER_ARC_TAIL_OPACITY) / 2;

/** Gradient steps per half-ring. Eight holds the residual skew under 0.01 alpha. */
export const SPINNER_ARC_STOP_COUNT = 8;

/** One `<Stop>` of a half-ring's gradient. */
export type SpinnerArcStop = { offset: number; opacity: number };

/**
 * Gradient stops that dim a half-ring at a constant rate per degree of turn.
 *
 * A linear gradient interpolates along its axis, and the axis here is `y` — but
 * a point at angle θ clockwise from the top sits at `y = 12 - 10·cos θ`, so two
 * stops alone make the fade stall near 3 and 9 o'clock and race through 12 and
 * 6. The ring then reads as a bright chunk beside a flat grey quadrant rather
 * than as an even comet.
 *
 * Each stop is therefore placed at the offset the arc actually occupies at that
 * angle while its opacity steps evenly, which inverts the skew. Both half-rings
 * share the resulting offset ladder; only the endpoints differ.
 *
 * Pure, so the whole ladder is reachable from `bun test`. See AGENTS.md.
 */
export function spinnerArcStops(from: number, to: number): SpinnerArcStop[] {
	return Array.from({ length: SPINNER_ARC_STOP_COUNT + 1 }, (_unused, index) => {
		const turn = index / SPINNER_ARC_STOP_COUNT;

		return {
			offset: (1 - Math.cos(Math.PI * turn)) / 2,
			opacity: from + (to - from) * turn,
		};
	});
}

/** Edge length used with no `size` prop and nothing to inherit from — 24pt. */
export const SPINNER_FALLBACK_SIZE_CLASS = "size-icon-xl";

/**
 * Sizing a glyph composed into a spinner inherits.
 *
 * It fills rather than pinning a step, so it still matches at a numeric `size`
 * — which the class scale cannot express, since Tailwind's scanner is static and
 * a runtime `size-[40px]` is never compiled.
 */
export const SPINNER_GLYPH_SIZE_CLASS = "size-full";

/** Named colour used with no `color` prop and nothing to inherit from. */
export const SPINNER_FALLBACK_COLOR: SpinnerColor = "default";

/**
 * Styling for every part of a spinner.
 *
 * Neither slot carries a colour: the glyph is an SVG stroke, which takes a
 * resolved value rather than a class. See {@link SPINNER_COLOR_TOKEN}.
 *
 * Free of React Native imports so it stays unit-testable — `bun test` cannot
 * parse React Native's Flow-typed source. See AGENTS.md.
 */
export const spinnerVariants = tv({
	slots: {
		// The root is the only sized box in a spinner. Everything under it fills.
		root: "items-center justify-center",
		// `size-full` is load-bearing rather than tidiness. The arc is an `<Svg>`
		// with no width or height, which react-native-svg resolves to `'100%'`.
		// If this layer were content-sized instead, that percentage would resolve
		// against an indefinite parent and the glyph would collapse to zero.
		content: "size-full items-center justify-center",
	},
	variants: {
		size: {
			xs: { root: "size-icon-xs" },
			sm: { root: "size-icon-sm" },
			md: { root: "size-icon-md" },
			lg: { root: "size-icon-lg" },
			xl: { root: "size-icon-xl" },
			"2xl": { root: "size-icon-2xl" },
		},
	},
});

/** Whether a size is one of the named steps rather than an edge length in points. */
export function isSpinnerSize(size: SpinnerSize | number | undefined): size is SpinnerSize {
	return typeof size === "string";
}

/**
 * The class chain that sizes a spinner's root, weakest source first: the
 * fallback, the enclosing component's icon class, this spinner's named size,
 * then the caller's own className.
 *
 * A numeric size drops the chain's sizing entirely rather than leaving a losing
 * class behind: the root takes the number through `style`, and relying on an
 * inline style to out-rank a className-derived one is a dependency worth not
 * having. Tailwind cannot help either way — its scanner is static, so a runtime
 * `size-[40px]` is never compiled and would draw nothing.
 *
 * Precedence matches {@link resolveSpinnerColor}, and the rule `Icon` follows,
 * so a spinner composed into a button matches it without being told to.
 *
 * Pure, so the whole ladder is reachable from `bun test`. See AGENTS.md.
 */
export function resolveSpinnerRootClass({
	size,
	inherited,
	className,
}: {
	size?: SpinnerSize | number;
	inherited?: string;
	className?: string;
}): string {
	const isNumeric = typeof size === "number";

	return cn(
		isNumeric ? undefined : SPINNER_FALLBACK_SIZE_CLASS,
		isNumeric ? undefined : inherited,
		spinnerVariants({ size: isSpinnerSize(size) ? size : undefined }).root({ className })
	);
}

function isSpinnerColor(color: string): color is SpinnerColor {
	return (SPINNER_COLORS as readonly string[]).includes(color);
}

/**
 * Colour string to hand `useThemeColor`.
 *
 * A named colour maps through {@link SPINNER_COLOR_TOKEN}; anything else — a
 * theme token such as `muted-foreground`, or a literal `#EC4899` — passes
 * through untouched for the hook to resolve or pass on.
 *
 * Precedence matches {@link resolveSpinnerRootClass}: explicit prop, then the
 * inherited token, then the fallback.
 */
export function resolveSpinnerColor(color: string | undefined, inherited?: string): string {
	const value = color ?? inherited ?? SPINNER_FALLBACK_COLOR;
	return isSpinnerColor(value) ? SPINNER_COLOR_TOKEN[value] : value;
}
