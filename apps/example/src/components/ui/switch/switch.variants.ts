import type { VariantProps } from "tailwind-variants";
import { tv } from "@/lib/tv";
import type { IconSize } from "@/components/ui/icon/icon.variants";

/** What a switch that is on means. Badge's, Checkbox's and Slider's set. */
export const SWITCH_COLORS = ["default", "primary", "success", "warning", "destructive", "info"] as const;

export const SWITCH_SIZES = ["sm", "md", "lg"] as const;

export type SwitchColor = (typeof SWITCH_COLORS)[number];
export type SwitchSize = (typeof SWITCH_SIZES)[number];

/**
 * The axes a switch falls back to when nothing names one.
 *
 * Named once because two places read them — `defaultVariants` below and
 * {@link resolveSwitchAxes}, which runs before `tv` is ever called. A test pins
 * the pair, since a drift between them is a switch that renders at one size and
 * reports another.
 */
export const SWITCH_DEFAULT_COLOR: SwitchColor = "default";
export const SWITCH_DEFAULT_SIZE: SwitchSize = "md";

/**
 * The step every glyph on this control is drawn at — inside the knob, or at
 * either end of the track. One step rather than two, so a tick inside the thumb
 * and a tick behind it are the same mark. The `glyph` slot writes it out and a
 * test pins the two together.
 */
export const SWITCH_CONTENT_ICON_STEP: Record<SwitchSize, IconSize> = { sm: "xs", md: "sm", lg: "md" };

/**
 * How far the knob sits inside the track, on every side, in points.
 *
 * One number rather than two. Horizontally it is written into the `thumb`,
 * `startContent` and `endContent` slots as `left-0.75` / `right-0.75` and
 * subtracted twice by {@link switchTravel}, so a slot and this constant
 * disagreeing is a knob that stops short of the far edge at every size — a test
 * pins the class against it.
 *
 * Vertically it is never written at all. The track is `justify-center`, so an
 * absolutely positioned child with no vertical inset is centred by its parent —
 * `Slider`'s rule, where the track centres the thumb and the thumb carries no
 * offset of its own. On that axis this is a *relationship* a test pins,
 * `(track height − knob height) / 2`, rather than a value anything reads.
 *
 * It is also what makes the two capsules concentric: both are `rounded-full`, so
 * each radius is half its own height and the difference between them is exactly
 * this inset. That is the subtraction `Checkbox`'s fill makes against its
 * border, arrived at by construction rather than by a second number.
 *
 * Three rather than two because two left the knob looking wedged against the
 * ends — a rounded rectangle needs a little more air around it than a disc,
 * whose curve already reads as clearance.
 */
export const SWITCH_THUMB_INSET = 3;

/**
 * The spring the thumb settles on after a tap or a release.
 *
 * **Critically damped on purpose**, where every other spring in this package
 * overshoots a little. A wider thumb travels a shorter distance inside a track
 * that clips it, so an overshoot has nowhere to go: the knob would visibly
 * squash against the end of its own capsule on every toggle. A test pins the
 * damping ratio at or above one, so a retune cannot quietly reintroduce it.
 */
export const SWITCH_THUMB_SPRING = { damping: 26, mass: 0.4, stiffness: 400 } as const;

/**
 * The spring the whole control settles on when it is pressed and released.
 *
 * Deliberately `Pressable`'s own `PRESS_SPRING`: a switch responding to a touch
 * is the same event as a button responding to one, and two springs a frame apart
 * would read as two things happening. `Slider` copies it for the same reason.
 */
export const SWITCH_PRESS_SPRING = { damping: 18, mass: 0.4, stiffness: 320 } as const;

/**
 * How far the whole control shrinks while a finger is on it.
 *
 * The **track** scales, not the thumb — the track is the outermost node, so it
 * is the one thing `overflow-hidden` cannot clip, and scaling the knob inside a
 * capsule that crops it would take a bite out of the knob rather than acknowledge
 * the press. It is also the only press feedback this control has: until a drag
 * actually moves the thumb, nothing else says the touch landed.
 */
export const SWITCH_PRESS_ANIMATION = { restScale: 1, pressedScale: 0.96 } as const;

/**
 * How far a release may have travelled and still count as a tap, in points.
 *
 * A finger never leaves a control perfectly still, so "did not move" has to be a
 * tolerance rather than zero. Below it the release toggles whatever the state
 * was; above it the position and the velocity decide, and a drag that went out
 * and came back therefore commits nothing.
 */
export const SWITCH_TAP_SLOP = 4;

/**
 * The release speed that decides the outcome on its own, in points per second.
 *
 * A flick is a statement of intent: let go fast enough and the switch goes the
 * way the finger was going, however short of half way it stopped. Without it a
 * quick flick from the left edge would spring back, because the thumb never got
 * past the middle — the one case where position is the wrong question.
 */
export const SWITCH_FLING_VELOCITY = 500;

/**
 * Theme token the track fades **to** at each colour.
 *
 * `default` names `foreground` rather than `primary`, and the two are the same
 * value in this theme today — the situation `Badge` documents for its neutral
 * end and `Slider` repeats. `foreground` is the page's ink and `primary` is the
 * brand's action colour; collapsing them would be the drift, not the
 * duplication, since an app that re-themes `primary` to blue wants
 * `color="primary"` blue and `color="default"` still ink.
 */
export const SWITCH_TRACK_TOKEN: Record<SwitchColor, string> = {
	default: "foreground",
	primary: "primary",
	success: "success",
	warning: "warning",
	destructive: "destructive",
	info: "info",
};

/**
 * The track a switch that is off wears.
 *
 * `input` rather than `secondary`, and it is the token that makes the knob
 * legible without a border: it is the chrome a field's own box wears, a step
 * darker than the page in light and a step lighter in dark, so a knob painted
 * the page's own colour reads against it at either end of the theme. `secondary`
 * sits too close to the surface behind it for that.
 */
export const SWITCH_TRACK_REST_TOKEN = "input";

/** The track, on or off, once the switch is reporting an invalid value. */
export const SWITCH_INVALID_TRACK_TOKEN = "destructive";

/**
 * Theme token the thumb fades **to** at each colour.
 *
 * Every entry is the `-foreground` of its own {@link SWITCH_TRACK_TOKEN} entry,
 * which is rule 11 doing its job: a single pale knob would be unreadable on
 * `warning`, whose foreground is near-black, so the knob follows the surface it
 * sits on. `default` is the exception the theme forces — there is no
 * `--foreground-foreground`, and `background` is what content drawn on the
 * page's ink actually is. A test pins the whole map against the track's rather
 * than trusting two tables to stay in step.
 */
export const SWITCH_THUMB_TOKEN: Record<SwitchColor, string> = {
	default: "background",
	primary: "primary-foreground",
	success: "success-foreground",
	warning: "warning-foreground",
	destructive: "destructive-foreground",
	info: "info-foreground",
};

/** The thumb a switch that is off wears. */
export const SWITCH_THUMB_REST_TOKEN = "background";

/** The thumb, on or off, once the switch is reporting an invalid value. */
export const SWITCH_INVALID_THUMB_TOKEN = "destructive-foreground";

/** The colour a glyph inside `Switch.EndContent` takes — it sits on the *off* track. */
export const SWITCH_CONTENT_REST_TOKEN = "secondary-foreground";

/**
 * The `text-*` class a `Text` inside a content layer takes at each colour.
 *
 * A colour that has to reach a glyph is a token; a colour that has to reach a
 * `Text` is a class, because text colour goes on the `Text` and a `View` does
 * not cascade it (rule 1). So this map exists beside {@link SWITCH_THUMB_TOKEN}
 * rather than being derived from it: Tailwind's scanner is static, so a runtime
 * `text-${token}` is never compiled and would silently draw nothing. A test pins
 * every entry against the token it must agree with, which is the difference
 * between a coupling that is checked and one that is merely hoped for.
 */
export const SWITCH_CONTENT_TEXT_CLASS: Record<SwitchColor, string> = {
	default: "text-background",
	primary: "text-primary-foreground",
	success: "text-success-foreground",
	warning: "text-warning-foreground",
	destructive: "text-destructive-foreground",
	info: "text-info-foreground",
};

/** What a `Text` inside `Switch.EndContent` takes — it sits on the *off* track. */
export const SWITCH_CONTENT_REST_TEXT_CLASS = "text-secondary-foreground";

/** What either content layer takes once the switch is reporting an invalid value. */
export const SWITCH_INVALID_CONTENT_TEXT_CLASS = "text-destructive-foreground";

/**
 * Styling for every part of a switch.
 *
 * One slotted `tv()` rather than a call per part, because `switch-thumb.tsx` and
 * the two content parts cannot import the root without closing a cycle
 * (AGENTS.md rule 3) yet all three read the same `size`.
 *
 * **It describes geometry, and almost no colour.** Every colour on this control
 * fades between two token *values* off the one `progress` — the track, the thumb
 * and both content layers — and a colour being interpolated cannot be a class,
 * which is the rule `Checkbox`'s border already follows. So there is no `color`
 * axis here at all: the maps above are where the colour lives, and the base
 * classes are only the resting appearance the animated styles start from. Adding
 * a `bg-*` per colour here would be a second source for one surface, which is
 * how a class and a style end up disagreeing for a frame on every toggle.
 *
 * **The track's height and the touch padding ride in the same size cell**,
 * because they are one number: they sum to 44pt at every size. Split them across
 * two variants and a retune of the track silently shrinks the target — the trap
 * `Slider` names, and a test asserts the sum rather than the parts.
 *
 * **The thumb is as wide as the track is tall, and shorter than it.** It is a
 * rounded rectangle lying on its side, not a disc — which is why it stopped
 * reading `--spacing-icon-*` and became plain spacing steps. That is the move
 * `Slider`'s handle already made, and for the same reason: the icon scale is
 * where a *glyph* belongs, and a knob is the body of the control rather than a
 * mark drawn on it. `Checkbox` still reads that scale because its square really
 * is a glyph in a box.
 *
 * Three relationships hold at every size and a test pins each, so the ladder can
 * be retuned without the test becoming a transcript of it: the thumb's width is
 * the track's height, its height is that less twice
 * {@link SWITCH_THUMB_INSET}, and the two capsules are therefore concentric.
 *
 * **The knob draws no border and no shadow.** A border is a second line drawn
 * where there is already a boundary — the knob is a solid block against a track
 * of a different colour — and against a saturated track it reads as a dark ring
 * rather than as definition. `Slider`'s handle dropped its own for the same
 * reason. Contrast at rest comes from the track's colour instead, which is why
 * {@link SWITCH_TRACK_REST_TOKEN} is `input`.
 *
 * **A content layer is as wide as the thumb's travel, not as wide as the
 * thumb.** It occupies exactly the space the knob vacates at its own end — which
 * is what the travel *is* — so the two layers and the thumb tile the track
 * instead of overlapping. Size them like the knob and they reach under it: the
 * far layer's text is then clipped by a knob drawn on top of it, visible only at
 * the size where the text is longest. They keep the thumb's *height*, so a glyph
 * at either end sits on the knob's own centre line.
 *
 * **Every slot that can hold a caller's content centres it.** The thumb and both
 * content layers are boxes a glyph is dropped into, and a `View` lays a child out
 * at flex-start by default — so a glyph in a knob that did not centre sits up
 * against its top-left corner, inside a circle, which reads as a mispositioned
 * icon rather than as a missing class. A test sweeps all three.
 *
 * **`overflow-hidden` on the track is load-bearing, not tidiness.** A caller's
 * `Switch.StartContent` is arbitrary content sitting inside a fully rounded
 * capsule, and without the clip a wide glyph paints over the track's own edge.
 * It is also why the thumb does **not** grow when grabbed the way a `Slider`'s
 * does: a scaled thumb would be clipped by the very same rule, and a knob
 * already following the finger does not need a second signal.
 *
 * **The fade lands on `touchArea`, the one slot no animated style touches.**
 * `track` and `thumb` both carry a `useAnimatedStyle`, and while neither writes
 * `opacity` today, a disabled treatment that would break the moment one did is a
 * treatment waiting to fail silently — the failure mode `Pressable` once had
 * with a class on its own animated node.
 *
 * **`self-start` is load-bearing.** A switch is sized by its own geometry, and
 * inside a gap column every child is stretch-aligned by default — without it the
 * touch area spans the screen and a tap far from the pill toggles it.
 *
 * No slot worn by a `View` carries `text-*`; a glyph's colour is a token handed
 * to an `IconDefaultsProvider`. See AGENTS.md rule 1.
 *
 * Free of React Native imports so it stays unit-testable — `bun test` cannot
 * parse React Native's Flow-typed source. See AGENTS.md.
 */
export const switchVariants = tv({
	slots: {
		/** The transparent box the drag is claimed on. Padded on the cross axis only. */
		touchArea: "self-start items-center justify-center",
		/** The capsule. Its colour is an animated style, never a class. */
		track: "relative justify-center overflow-hidden rounded-full bg-input",
		/** The knob. Its position and its colour are one animated style. */
		thumb: "absolute left-0.75 items-center justify-center rounded-full bg-background",
		/** Behind the thumb at the leading edge. Revealed as the switch turns on. */
		startContent: "absolute left-0.75 items-center justify-center",
		/** Behind the thumb at the trailing edge. Revealed as the switch turns off. */
		endContent: "absolute right-0.75 items-center justify-center",
		/** Edge length any glyph on this control inherits — inside the knob, or at either end. */
		glyph: "",
		/** Handed to a `TextClassProvider`, never worn by a `View`. Its colour is added per end. */
		contentText: "font-semibold",
	},
	variants: {
		size: {
			sm: {
				touchArea: "py-2.5",
				track: "h-6 w-11",
				thumb: "h-4.5 w-6",
				startContent: "h-4.5 w-3.5",
				endContent: "h-4.5 w-3.5",
				glyph: "size-icon-xs",
				contentText: "text-[8px]",
			},
			md: {
				touchArea: "py-2",
				track: "h-7 w-13",
				thumb: "h-5.5 w-7",
				startContent: "h-5.5 w-4.5",
				endContent: "h-5.5 w-4.5",
				glyph: "size-icon-sm",
				contentText: "text-[10px]",
			},
			lg: {
				touchArea: "py-1",
				track: "h-9 w-17",
				thumb: "h-7.5 w-9",
				startContent: "h-7.5 w-6.5",
				endContent: "h-7.5 w-6.5",
				glyph: "size-icon-md",
				contentText: "text-[10px]",
			},
		},
		// The empty `false` branch is load-bearing typing, not a placeholder. `tv`
		// derives the prop type from the declared keys, so a map with only `true`
		// types the prop as `true` rather than `boolean`.
		isDisabled: { true: { touchArea: "opacity-50" }, false: {} },
	},
	defaultVariants: {
		size: SWITCH_DEFAULT_SIZE,
		isDisabled: false,
	},
});

/** What a switch was given at its own call site. */
export type SwitchOwnAxes = {
	color?: SwitchColor;
	size?: SwitchSize;
	isDisabled?: boolean;
	isInvalid?: boolean;
};

/** What an enclosing `Field` publishes, or null outside one. */
export type SwitchFieldAxes = { isDisabled?: boolean; isInvalid?: boolean };

/** Every axis settled, ready to hand to {@link switchVariants} and to context. */
export type SwitchAxes = {
	color: SwitchColor;
	size: SwitchSize;
	isDisabled: boolean;
	isInvalid: boolean;
};

/**
 * Settles a switch's axes from the two places they can come from.
 *
 * A two-rung ladder rather than `Checkbox`'s three, because there is no
 * `Switch.Group`: the switch's own props first, an enclosing `Field` last. A
 * switch inside a disabled `Field` dims with nothing said at the call site,
 * while `isDisabled={false}` still opts that one control out — `??` throughout
 * and never `||`, so an explicit `false` is a value rather than an absence.
 *
 * A `Field` reaches the two *state* axes only. It cannot acquire a paint axis by
 * accident, and a test pins that.
 *
 * Pure, so the whole matrix is reachable from `bun test`. See AGENTS.md.
 */
export function resolveSwitchAxes({ own, field }: { own?: SwitchOwnAxes; field?: SwitchFieldAxes | null }): SwitchAxes {
	return {
		color: own?.color ?? SWITCH_DEFAULT_COLOR,
		size: own?.size ?? SWITCH_DEFAULT_SIZE,
		isDisabled: own?.isDisabled ?? field?.isDisabled ?? false,
		isInvalid: own?.isInvalid ?? field?.isInvalid ?? false,
	};
}

/** The two ends the track's colour interpolates between. */
export function resolveSwitchTrackTokens({ color, isInvalid }: { color: SwitchColor; isInvalid: boolean }): {
	rest: string;
	active: string;
} {
	if (isInvalid) return { rest: SWITCH_INVALID_TRACK_TOKEN, active: SWITCH_INVALID_TRACK_TOKEN };
	return { rest: SWITCH_TRACK_REST_TOKEN, active: SWITCH_TRACK_TOKEN[color] };
}

/**
 * The two ends the thumb's colour interpolates between.
 *
 * An **invalid** switch returns destructive at both ends, on the track and on the
 * knob, so there is nothing to fade — the colour is the signal the value is
 * wrong, and it has to be there before the switch is turned on as much as after.
 * The precedence `Checkbox` sets on its border.
 */
export function resolveSwitchThumbTokens({ color, isInvalid }: { color: SwitchColor; isInvalid: boolean }): {
	rest: string;
	active: string;
} {
	if (isInvalid) return { rest: SWITCH_INVALID_THUMB_TOKEN, active: SWITCH_INVALID_THUMB_TOKEN };
	return { rest: SWITCH_THUMB_REST_TOKEN, active: SWITCH_THUMB_TOKEN[color] };
}

/**
 * Whether the caller wrote a `Switch.Thumb` of their own.
 *
 * The root composes one in when they did not, which is what makes `<Switch />`
 * on its own a complete control — `Radio`'s rule for its indicator, and for the
 * same reason: a switch has exactly one thumb, so it can know that a caller who
 * wrote none wants the default rather than an empty capsule.
 *
 * Takes an array of "is this child a thumb" rather than the children themselves,
 * so it stays free of React and reachable from `bun test` — the trade
 * `resolveIndicatorPlacement` already makes.
 */
export function hasThumbChild(isThumb: readonly boolean[]): boolean {
	return isThumb.some(Boolean);
}

/**
 * How far the thumb can travel, in points.
 *
 * A measured `0` means **not measured yet**, never "a track with no length", so
 * this is floored rather than allowed to go negative: the thumb sits at the
 * leading edge until both layouts have reported. `Slider` guards the same way.
 */
export function switchTravel({
	trackWidth,
	thumbWidth,
	inset,
}: {
	trackWidth: number;
	thumbWidth: number;
	/** {@link SWITCH_THUMB_INSET}. Taken off both ends. */
	inset: number;
}): number {
	"worklet";
	const travel = trackWidth - thumbWidth - inset * 2;
	return travel > 0 ? travel : 0;
}

/**
 * Where a release leaves the switch.
 *
 * Three questions in order, and the order is the design. A release whose finger
 * barely moved **in any direction** is a tap, so it toggles whatever the state
 * was — this is what lets one `Gesture.Pan()` serve both gestures rather than
 * racing a `Tap` against it. `distance` is deliberately not the along-track
 * translation: a vertical swipe that began on the switch moves nothing
 * horizontally, and reading only that axis would turn every attempt to scroll
 * past the control into a toggle. A release travelling fast is a **flick**, and
 * goes the way the finger was going however short of half way it stopped.
 * Anything else is settled by position.
 *
 * Marked `"worklet"` and written flat — it calls nothing, not even to clamp.
 * A module-scope worklet is rewritten into a factory call that runs at import
 * time in source order, so one calling a sibling works only while the sibling
 * happens to be declared first, and a tidy-up that reorders the file crashes the
 * UI thread. See AGENTS.md under **Slider**.
 *
 * Pure, so `bun test` reaches the whole matrix.
 */
export function resolveSwitchRelease({
	progress,
	distance,
	velocity,
	wasSelected,
}: {
	progress: number;
	/** How far the finger moved, in points, on whichever axis moved further. */
	distance: number;
	velocity: number;
	wasSelected: boolean;
}): boolean {
	"worklet";
	if (distance < SWITCH_TAP_SLOP) return !wasSelected;
	if (velocity > SWITCH_FLING_VELOCITY) return true;
	if (velocity < -SWITCH_FLING_VELOCITY) return false;
	return progress > 0.5;
}

/** Which end of the track a content layer sits at. */
export type SwitchContentPlacement = "start" | "end";

/**
 * The colour a content layer's glyphs and text take.
 *
 * The two ends sit on different surfaces, and that is the whole of the
 * decision: `Switch.StartContent` is revealed when the switch is **on**, so it
 * is drawn on the coloured track and takes that colour's `-foreground`;
 * `Switch.EndContent` is revealed when it is **off**, so it is drawn on the
 * resting track and takes `secondary`'s. Invalid outranks both, the precedence
 * `Checkbox` sets on its border.
 *
 * Returns a token for the glyph and a class for the text, because those are what
 * an `IconDefaultsProvider` and a `TextClassProvider` respectively take — the
 * asymmetry AGENTS.md's **Theming** section sets out.
 *
 * Pure, so `bun test` reaches the whole matrix.
 */
export function resolveSwitchContentTreatment({
	color,
	isInvalid,
	placement,
}: {
	color: SwitchColor;
	isInvalid: boolean;
	placement: SwitchContentPlacement;
}): { color: string; textClass: string } {
	if (isInvalid) return { color: SWITCH_INVALID_THUMB_TOKEN, textClass: SWITCH_INVALID_CONTENT_TEXT_CLASS };
	if (placement === "end") return { color: SWITCH_CONTENT_REST_TOKEN, textClass: SWITCH_CONTENT_REST_TEXT_CLASS };
	return { color: SWITCH_THUMB_TOKEN[color], textClass: SWITCH_CONTENT_TEXT_CLASS[color] };
}

export type SwitchVariantProps = VariantProps<typeof switchVariants>;
