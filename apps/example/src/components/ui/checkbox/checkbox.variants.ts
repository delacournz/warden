import type { VariantProps } from "tailwind-variants";
import { tv } from "@/lib/tv";
import type { TextColor, TextSize } from "@/components/ui/text/text.variants";

/** What a ticked box means. The same six `Badge` paints, and for the same reason. */
export const CHECKBOX_COLORS = ["default", "primary", "success", "warning", "destructive", "info"] as const;

export const CHECKBOX_SIZES = ["sm", "md", "lg"] as const;

/** Which side of its label the box sits on. */
export const CHECKBOX_ALIGNMENTS = ["start", "end"] as const;

export type CheckboxColor = (typeof CHECKBOX_COLORS)[number];
export type CheckboxSize = (typeof CHECKBOX_SIZES)[number];
export type CheckboxAlignment = (typeof CHECKBOX_ALIGNMENTS)[number];

/**
 * Theme token whose value gives the tick its colour.
 *
 * The checkbox's counterpart to `BADGE_FOREGROUND_TOKEN`, and it exists for the
 * same reason: a colour that has to reach an SVG paint prop cannot be a class.
 * Every entry names the `-foreground` of the fill its own `indicator` slot
 * paints, so the glyph and the surface under it are never a shade apart — a test
 * asserts the pair rather than trusting two maps to stay in step.
 */
export const CHECKBOX_GLYPH_TOKEN: Record<CheckboxColor, string> = {
	default: "secondary-foreground",
	primary: "primary-foreground",
	success: "success-foreground",
	warning: "warning-foreground",
	destructive: "destructive-foreground",
	info: "info-foreground",
};

/** The tick's colour once the box is reporting an invalid value. */
export const CHECKBOX_INVALID_GLYPH_TOKEN = "destructive-foreground";

/**
 * Theme token each colour paints its filled surface with.
 *
 * The same value the `indicator` slot names as a `bg-*`, as a token this time,
 * because the border interpolates *to* it and a colour being animated has to be
 * a value rather than a class. A test pins the two against each other.
 *
 * `default` is `secondary` rather than a colour of its own: this theme's
 * `primary` is a near-black, and its neutral fill already exists.
 */
export const CHECKBOX_SURFACE_TOKEN: Record<CheckboxColor, string> = {
	default: "secondary",
	primary: "primary",
	success: "success",
	warning: "warning",
	destructive: "destructive",
	info: "info",
};

/**
 * The `rounded-*` step the box wears at each size.
 *
 * Named here as well as written into the `box` slot so the fill can be given
 * the same corner — see {@link resolveCheckboxFillRadius}. A test asserts the
 * two still agree.
 */
export const CHECKBOX_RADIUS_STEP: Record<CheckboxSize, "xs" | "sm"> = { sm: "xs", md: "xs", lg: "sm" };

/**
 * Width of the box's border in points — Tailwind's bare `border` utility.
 *
 * Restated here because two other things have to agree with it: the `indicator`
 * slot's `-inset-px`, which is how the fill reaches past the padding box to
 * cover the border ring, and `CheckboxBox`'s `onLayout`, which subtracts it
 * twice to turn the measured border box back into the padding box the tick clip
 * is positioned in.
 */
export const CHECKBOX_BORDER_WIDTH = 1;

/**
 * What each of those steps multiplies `--radius` by, restating `tokens.css`.
 *
 * It has to be restated: the corner scale is declared `@theme inline`, so
 * Tailwind substitutes each step into the utilities that use it and emits no
 * `--radius-xs` variable at all. `--radius` is the only one that survives to
 * runtime, so anything computing a corner in JavaScript has to do the
 * multiplication itself. `checkbox.variants.test.ts` pins both numbers against
 * `tokens.css`, so retuning the scale fails the build rather than quietly
 * leaving the fill behind.
 */
export const CHECKBOX_RADIUS_MULTIPLIER: Record<"sm" | "xs", number> = { xs: 0.4, sm: 0.6 };

/**
 * Corner radius of the animated fill, in points.
 *
 * The box's **own** radius, not a tighter one. The fill spans the whole border
 * box — see the `indicator` slot's `-inset-px` — so it wears the same corner the
 * box does and runs underneath the border ring rather than stopping against it.
 *
 * It was this minus the border width until it was not, which is the rule for two
 * rounded rectangles to stay concentric — and concentric was the bug. Two curves
 * that coincide are rasterised twice, on two layers, and antialiased
 * independently: at a corner pixel where each gives coverage `a` the composite
 * covers `2a - a²`, so `(1 - a)²` of the box's own `bg-card` bleeds through as a
 * dull arc. The straight edges are pixel-aligned and show nothing, which is why
 * the artifact was corner-only. Overlapping the two removes the shared edge
 * instead of concealing it, and holds on both platforms even though iOS paints a
 * `CALayer` border above its sublayers and Android paints it below.
 *
 * A function of the live `--radius` rather than a table of points, because
 * `--radius` is a consumer's to set — a pasted theme retunes every corner in
 * the package, and a fill left at a number tuned for the default would come
 * away from the border the moment anyone did. Clamped at zero so a
 * square-cornered theme draws a square fill rather than a negative radius.
 *
 * Pure, so the whole matrix is reachable from `bun test`. See AGENTS.md.
 */
export function resolveCheckboxFillRadius(size: CheckboxSize, radius: number): number {
	const step = CHECKBOX_RADIUS_MULTIPLIER[CHECKBOX_RADIUS_STEP[size]];

	return Math.max(0, radius * step);
}

/** The border of a box that is not filled — the same chrome a field wears. */
export const CHECKBOX_REST_BORDER_TOKEN = "input";

/** The border, filled or not, once the box is reporting an invalid value. */
export const CHECKBOX_INVALID_BORDER_TOKEN = "destructive";

/**
 * Styling for every part of a checkbox.
 *
 * One slotted `tv()` rather than a call per part, so `size` is declared once
 * across a box, the glyph inside it, the row's gap and the step the label asks
 * its preset for. The sibling file is what makes that possible: the slot set is
 * read by files that cannot import each other's roots without closing a cycle.
 *
 * **`color` paints the `indicator`, not the box.** The indicator is an
 * absolute-fill layer that is invisible until the box is ticked, so a colour
 * needs no unchecked branch — an unticked box is `border-input bg-card` at every
 * colour, the same chrome a field wears. That leaves `compoundVariants` holding
 * one cell rather than a thirty-six cell matrix.
 *
 * **The border is not a class at all.** It fades from the field chrome to the
 * fill's own colour as the surface scales out to meet it, which is a value being
 * interpolated rather than a class being swapped. {@link CHECKBOX_SURFACE_TOKEN}
 * and {@link resolveCheckboxBorderTokens} name the two ends; the base keeps
 * `border-input` as the resting appearance the animated style starts from.
 *
 * `overflow-hidden` on the box is load-bearing, not tidiness. The fill overhangs
 * the border box by a point on every side, and on Android a border is painted
 * below its children rather than above them — so the clip is what terminates the
 * fill at the box's corner rather than a point outside it.
 *
 * `border` sits in the base rather than on the filled branch. A border declared
 * only where it shows would move the glyph inside by a point the moment the box
 * was ticked.
 *
 * **The box reads the shared icon scale, two steps above its own glyph.** It
 * mints no scale of its own: a checkbox is a glyph in a box, both measurements
 * are already on `--spacing-icon-*`, and a private `--spacing-checkbox-*` would
 * be three numbers that have to be retuned in step with three others forever.
 * Two steps is the gap that leaves the tick breathing room — 18/14, 20/16,
 * 24/18 — and a test pins the offset rather than the numbers, so the scale can
 * be retuned without the test becoming a transcript of it.
 *
 * **The `label` slot holds layout and nothing else** — no size, no weight, no
 * colour. `Checkbox.Label` renders the `Text.Label` preset and passes a step and
 * a colour through {@link resolveCheckboxLabelSize} and
 * {@link resolveCheckboxLabelColor}, so the type scale lives in exactly one
 * place. A `text-sm font-medium` here would be a second definition of
 * `Text.Label` that could drift from it — `Field`'s rule, and the reason `Input`
 * ships no label part at all. The `View` slots hold no `text-*` either: a React
 * Native `View` does not cascade colour to a `Text` descendant. See AGENTS.md
 * rule 1.
 *
 * **The row aligns to the top, and the box carries a margin that puts it back.**
 * A wrapped label centred against its own paragraph drifts the box down the side
 * of it instead of leaving it on the first line — the same thing `Input` refuses
 * for a multiline field's decorators. `items-start` fixes that and would break
 * the ordinary single-line case, so each size adds a top margin of half the
 * difference between the label's line box and the box: 20/24/28 against
 * 18/20/24, which is 1pt, 2pt and 2pt. One line then renders exactly as
 * `items-center` did, and every line after it is a bonus rather than a
 * regression.
 *
 * `opacity-50` for a disabled checkbox goes on the **row**, so the label fades
 * with the box it names rather than standing at full strength beside a ghost.
 *
 * Free of React Native imports so it stays unit-testable — `bun test` cannot
 * parse React Native's Flow-typed source. See AGENTS.md.
 */
export const checkboxVariants = tv({
	slots: {
		root: "flex-row items-start",
		box: "items-center justify-center overflow-hidden border border-input bg-card",
		/**
		 * The animated fill. Runs under the box's border, and under the tick.
		 *
		 * `-inset-px` rather than `inset-0`, because an absolute child is positioned
		 * against the padding box: a negative inset of one border width is what
		 * reaches the border box. The overlap is what keeps the fill's edge and the
		 * border's from coinciding — see {@link resolveCheckboxFillRadius}.
		 */
		indicator: "absolute -inset-px",
		/**
		 * Clips the tick. Pinned to the box's left edge with an animated width, so
		 * the glyph is revealed across rather than grown into.
		 */
		tick: "absolute inset-y-0 left-0 overflow-hidden",
		/** Holds the glyph at the box's centre while the clip above it moves. */
		tickInner: "h-full items-center justify-center",
		/** Layout only. The treatment is the `Text.Label` preset's. */
		label: "shrink",
		/** Edge length the tick inherits. */
		glyph: "",
		/** `Checkbox.Group`'s column. */
		group: "gap-4",
	},
	variants: {
		// Paints the fill and nothing else — see the note above on why the box
		// needs no unchecked branch per colour.
		color: {
			default: { indicator: "bg-secondary" },
			primary: { indicator: "bg-primary" },
			success: { indicator: "bg-success" },
			warning: { indicator: "bg-warning" },
			destructive: { indicator: "bg-destructive" },
			info: { indicator: "bg-info" },
		},
		size: {
			// The box's top margin is half the difference between the label's line
			// box and the box itself — 20/24/28 against 18/20/24 — so a one-line
			// label reads as centred and a wrapped one keeps the box on its first
			// line. See the note above the slots.
			// The box and the glyph inside it read the *same* scale, two steps
			// apart — see the note above the slots.
			sm: { root: "gap-2", box: "mt-px size-icon-md rounded-xs", glyph: "size-icon-xs" },
			md: { root: "gap-2.5", box: "mt-0.5 size-icon-lg rounded-xs", glyph: "size-icon-sm" },
			lg: { root: "gap-3", box: "mt-0.5 size-icon-xl rounded-sm", glyph: "size-icon-md" },
		},
		alignment: {
			start: {},
			// `flex-row-reverse` rather than a branch in the JSX: the box is
			// rendered first either way, so the decision stays a class and the whole
			// matrix stays reachable from `bun test`.
			end: { root: "flex-row-reverse", label: "grow" },
		},
		// The empty `false` branches are load-bearing typing, not placeholders.
		// `tv` derives the prop type from the declared keys, so a map with only
		// `true` types the prop as `true` rather than `boolean` and rejects
		// `checkboxVariants({ isFilled })`. See the note in button.variants.ts.
		//
		// Named `isFilled` rather than `isChecked` because checked and
		// indeterminate both paint the surface and only the glyph tells them
		// apart. `resolveCheckboxFilled` is that translation.
		isFilled: { true: {}, false: {} },
		isInvalid: { true: {}, false: {} },
		isDisabled: { true: { root: "opacity-50" }, false: {} },
	},
	compoundVariants: [
		// Invalid outranks the colour on the fill, whether the box is ticked or
		// not. A checkbox that stayed green while its value was rejected would
		// drop the only signal it has, exactly while the value is being corrected
		// — the precedence `Input` sets between invalid and focus.
		//
		// The *border* is not here. It interpolates between two token values as
		// the fill approaches the edge, so it is a style rather than a class —
		// see `resolveCheckboxBorderTokens`.
		{ isInvalid: true, class: { indicator: "bg-destructive" } },
	],
	defaultVariants: {
		color: "default",
		size: "md",
		alignment: "start",
		isFilled: false,
		isInvalid: false,
		isDisabled: false,
	},
});

/**
 * [unfilled, filled] for the fill's two tracks, plus the tick's timing.
 *
 * The fill fades and scales **from the centre of the box**. It does not travel:
 * a translation would make the surface arrive from one edge, which reads as a
 * panel sliding in rather than as a box being filled, and there is no direction
 * a checkbox is filled *from*.
 *
 * The tick is not part of that. It is clipped by a container whose width opens
 * from the box's left edge, so the glyph is drawn on rather than faded up —
 * which is what makes ticking look like ticking, and unticking look like the
 * stroke being taken back. `tickDelay` holds it until the surface it is drawn on
 * is most of the way there; starting both at once reads as one blurred event.
 *
 * One shared progress value drives all of it through `interpolate`, so the
 * tracks cannot drift out of step and there is one animation rather than three.
 *
 * Pure data, so a test can pin that every track travels and that the filled end
 * is a finished box rather than something stopped mid-animation.
 */
export const CHECKBOX_INDICATOR_ANIMATION = {
	opacity: [0, 1],
	scale: [0.8, 1],
	/** Fraction of the fill's travel that passes before the tick starts to draw. */
	tickDelay: 0.25,
	/**
	 * Fraction that passes before the border starts taking the fill's colour.
	 *
	 * Later than the tick, because the border should read as the surface
	 * *reaching* it rather than as a second thing changing alongside it. The fill
	 * scales 0.8 → 1, so it is only near the edge in the last of its travel.
	 */
	borderDelay: 0.55,
	durationMs: 140,
} as const;

/**
 * Points of slop that bring a bare box up to the 44pt minimum touch target.
 *
 * New to this package, and deliberate: `Badge.CloseButton` needs none because it
 * sits inside a padded capsule, while a bare `md` checkbox is a 20pt square with
 * nothing around it.
 */
export const CHECKBOX_HIT_SLOP: Record<CheckboxSize, number> = { sm: 13, md: 12, lg: 10 };

/**
 * Whether the box paints its surface.
 *
 * Indeterminate fills exactly as checked does — only the glyph differs, a dash
 * instead of a tick — so the two collapse to one visual state here and the tv()
 * axis is named for that rather than for `checked`.
 *
 * Pure, so the matrix is reachable from `bun test`. See AGENTS.md.
 */
export function resolveCheckboxFilled({
	isChecked,
	isIndeterminate,
}: {
	isChecked: boolean;
	isIndeterminate: boolean;
}): boolean {
	return isChecked || isIndeterminate;
}

/** The axes a checkbox can take from itself, its group, or the field around it. */
export type CheckboxAxes = {
	color?: CheckboxColor;
	size?: CheckboxSize;
	alignment?: CheckboxAlignment;
	isInvalid?: boolean;
	isDisabled?: boolean;
};

/** What an enclosing `Field` contributes — state only; it has no opinion on colour. */
export type CheckboxFieldAxes = { isInvalid?: boolean; isDisabled?: boolean };

/**
 * The axes a checkbox actually draws with, given the wrappers around it.
 *
 * The ladder is `own ?? group ?? field ?? default`, on every axis, and the
 * middle rung is where this differs from `Input`.
 *
 * `Input`'s ladder puts its group **first**, because `Input.Group` owns the one
 * box a grouped field renders into — a field's own `variant` there would be a
 * second answer to a question already settled. `Checkbox.Group` owns no box. It
 * is a state controller that also carries shared defaults, which makes it the
 * same kind of thing as `Field`: a wrapper a control can override. So "make the
 * group `lg`" and "make this one destructive" are different questions, and both get
 * an answer.
 *
 * `??` throughout and never `||`, so an explicit `false` opts a control out of
 * an invalid field rather than reading as an absence.
 *
 * Pure, so the whole ladder is reachable from `bun test`. See AGENTS.md.
 */
export function resolveCheckboxAxes({
	own,
	group,
	field,
}: {
	own: CheckboxAxes;
	group?: CheckboxAxes;
	field?: CheckboxFieldAxes;
}): Required<CheckboxAxes> {
	return {
		color: own.color ?? group?.color ?? "default",
		size: own.size ?? group?.size ?? "md",
		alignment: own.alignment ?? group?.alignment ?? "start",
		isInvalid: own.isInvalid ?? group?.isInvalid ?? field?.isInvalid ?? false,
		isDisabled: own.isDisabled ?? group?.isDisabled ?? field?.isDisabled ?? false,
	};
}

/**
 * The value list a group holds after one entry is toggled.
 *
 * Appends when absent and filters when present, so the order values were checked
 * in survives and a duplicate that somehow got in is cleared rather than halved.
 * Always a new array: React bails out of a re-render on an unchanged reference,
 * so a mutation here would flip the state and leave the screen alone.
 *
 * Pure, so it is reachable from `bun test`. See AGENTS.md.
 */
export function toggleCheckedValue(current: readonly string[], value: string): string[] {
	return current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value];
}

/**
 * The `Text` step `Checkbox.Label` hands its preset.
 *
 * A size, never a class. The checkbox's own step names map onto `TEXT_SIZES`'
 * own, so the two scales stay level without either restating the other.
 *
 * Pure, so it is reachable from `bun test`. See AGENTS.md.
 */
export function resolveCheckboxLabelSize(size: CheckboxSize): TextSize {
	switch (size) {
		case "sm":
			return "sm";
		case "lg":
			return "lg";
		default:
			return "md";
	}
}

/**
 * The `Text` colour `Checkbox.Label` hands its preset.
 *
 * Returning `undefined` is meaningful rather than lazy: `Text`'s colour axis
 * emits nothing when it is not named, so the label falls through to
 * `Text.Label`'s own `text-foreground`. The same contract `resolveFieldTextColor`
 * uses, and it is what lets the label say "leave it alone".
 *
 * Pure, so it is reachable from `bun test`. See AGENTS.md.
 */
export function resolveCheckboxLabelColor(isInvalid: boolean): TextColor | undefined {
	return isInvalid ? "destructive" : undefined;
}

/**
 * The slop a checkbox's tap target takes beyond the box itself.
 *
 * Only a bare box gets any. Once there is a label the whole row is the target
 * and is already wide, and slop on top of that would overlap the next row's —
 * making a tap between two checkboxes ambiguous, which is worse than the target
 * being merely adequate.
 *
 * Pure, so it is reachable from `bun test`. See AGENTS.md.
 */
export function resolveCheckboxHitSlop({
	size,
	hasLabel,
}: {
	size: CheckboxSize;
	hasLabel: boolean;
}): number | undefined {
	return hasLabel ? undefined : CHECKBOX_HIT_SLOP[size];
}

/**
 * The two theme tokens a box's border travels between.
 *
 * `rest` is what an unfilled box wears and `active` is what a filled one settles
 * on — the fill's own colour, so the border reads as the surface having reached
 * the edge rather than as an outline that changed on its own.
 *
 * An invalid box returns destructive for **both**, so there is nothing to fade: the
 * border is the signal that the value is wrong, and it has to be there before
 * the box is ticked as much as after. That is the same precedence `Input` sets
 * between invalid and focus, expressed as a pair of endpoints instead of a
 * compound variant.
 *
 * Pure, so the whole matrix is reachable from `bun test`. See AGENTS.md.
 */
export function resolveCheckboxBorderTokens({ color, isInvalid }: { color: CheckboxColor; isInvalid: boolean }): {
	rest: string;
	active: string;
} {
	if (isInvalid) {
		return { active: CHECKBOX_INVALID_BORDER_TOKEN, rest: CHECKBOX_INVALID_BORDER_TOKEN };
	}
	return { active: CHECKBOX_SURFACE_TOKEN[color], rest: CHECKBOX_REST_BORDER_TOKEN };
}

export type CheckboxVariantProps = VariantProps<typeof checkboxVariants>;
