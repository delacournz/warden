import type { VariantProps } from "tailwind-variants";
import { tv } from "@/lib/tv";
import type { TextSize } from "@/components/ui/text/text.variants";

/** How the bar is painted. `primary` is a capsule in a track, `secondary` an underline. */
export const TABS_VARIANTS = ["primary", "secondary"] as const;

export const TABS_SIZES = ["sm", "md", "lg"] as const;

/** Where a `Tabs.ScrollView` puts the selected trigger. `none` leaves the bar alone. */
export const TABS_SCROLL_ALIGNS = ["start", "center", "end", "none"] as const;

export type TabsVariant = (typeof TABS_VARIANTS)[number];
export type TabsSize = (typeof TABS_SIZES)[number];
export type TabsScrollAlign = (typeof TABS_SCROLL_ALIGNS)[number];

/**
 * The axes the bar falls back to when nothing names one.
 *
 * Named once because two places read them — `defaultVariants` below, and the
 * resolvers, which run before `tv` is ever called. A test pins the pair, since a
 * drift between them is a bar that renders at one size and reports another.
 */
export const TABS_DEFAULT_VARIANT: TabsVariant = "primary";
export const TABS_DEFAULT_SIZE: TabsSize = "md";
export const TABS_DEFAULT_SCROLL_ALIGN: TabsScrollAlign = "center";

/**
 * The `Text` size step each bar size hands its label.
 *
 * `Tabs.Label` renders `Text.Label` and names this step rather than restating a
 * type scale in the `label` slot, so the weight stays in exactly one place — the
 * preset — while the label still tracks the bar's size. A test asserts every
 * value here is a size `Text` actually has.
 */
export const TABS_LABEL_TEXT_SIZE: Record<TabsSize, TextSize> = { sm: "sm", md: "md", lg: "lg" };

/**
 * The theme token a trigger's label and any glyph beside it take.
 *
 * Nested rather than flat, so adding a variant is a compile error in two places
 * instead of a silent gap in one.
 *
 * This is the **only** place either colour is named. The label crossfades between
 * them on the UI thread and a composed `Icon` takes one of them as a resolved
 * value, and neither of those can be a class — so the `label` slot carries no
 * colour at all and this map is what `bun test` sweeps instead. `Checkbox`'s
 * animated border makes the same trade for the same reason.
 */
export const TABS_FOREGROUND_TOKEN: Record<TabsVariant, { selected: string; unselected: string }> = {
	primary: { selected: "elevated-foreground", unselected: "muted-foreground" },
	secondary: { selected: "foreground", unselected: "muted-foreground" },
};

/**
 * There is no radius arithmetic here, and its absence is the design.
 *
 * The track and the capsule are both `rounded-full`, so the capsule is
 * concentric inside the track at *any* padding — a pill inside a pill always is.
 * That is what `Checkbox`'s "radius minus border width" rule exists to achieve
 * for a rounded rectangle, and a fully rounded pair gets it for free.
 *
 * The earlier shape subtracted a padding from a named `rounded-*` step at each
 * size, which meant three maps that had to stay in step and a rectangle that
 * still read as boxy against its own track. Do not reintroduce them.
 */

/**
 * The spring the indicator and the panels settle on after a tap or a released pan.
 *
 * One spring for both, because they are two readings of one shared value and a
 * second config would be a second clock they could drift apart on. Deliberately
 * without `clamp`: Reanimated's `SpringConfig` is a mutually exclusive union and
 * `clamp` belongs to the `duration`/`dampingRatio` branch, so pairing it with
 * `stiffness` is a type error. A test pins that it stays absent.
 */
export const TABS_SETTLE_SPRING = { damping: 20, mass: 0.5, stiffness: 260 } as const;

/**
 * The pan's thresholds.
 *
 * `activateX` is how far a drag travels sideways before the pager claims it;
 * `failY` is how far it travels vertically before the pager gives up and lets the
 * scrollable above it through. `activateX` is the smaller of the two on purpose —
 * a diagonal drag has to resolve to exactly one of them, and the pager is the one
 * that cannot be reached any other way.
 *
 * `flingVelocity` is in **index units per second**, not points per second. In
 * points it would mean a different flick on a phone than on a tablet, because a
 * page is the width of the screen.
 *
 * `overscroll` bounds how far past the first or last tab a drag can pull, in the
 * same index units.
 */
export const TABS_PAN = { activateX: 10, failY: 14, flingVelocity: 0.5, overscroll: 0.25 } as const;

/**
 * How far past the midpoint the pager travels before the labels swap treatment.
 *
 * A finger held at exactly the midpoint would otherwise flip the label back and
 * forth every frame, and each flip costs a React commit. Must stay under 0.5, or
 * the visual index can never change at all.
 */
export const TABS_VISUAL_HYSTERESIS = 0.08;

/**
 * The ramp a separator fades on, in index units either side of the gap it fills.
 *
 * `hold` keeps it fully out for a little way either side of dead centre, so the
 * rule is properly gone while the capsule is over it rather than flickering
 * through a thin band.
 */
export const TABS_SEPARATOR_FADE = { distance: 0.45, hold: 0.1 } as const;

/** Points of the neighbouring trigger left visible by `scrollAlign` `start` and `end`. */
export const TABS_SCROLL_INSET = 16;

/** One trigger's frame in the row's own coordinate space. */
export type TabMeasurement = { x: number; width: number };

/**
 * The three arrays `interpolate` needs, built once per layout rather than per frame.
 *
 * Replaced as ONE value so their lengths can never disagree — `interpolate` throws
 * when the input and output ranges differ, and three separate shared values would
 * be three separate chances for the UI thread to read a half-updated set.
 */
export type TabTracks = { index: number[]; width: number[]; x: number[] };

/**
 * The list `position` indexes into.
 *
 * Panels first, because their order is known at the FIRST render — a registered
 * order only settles after every trigger's mount effect has run, which is one
 * commit late, and one commit of the wrong order is an indicator that visibly
 * lands on the wrong tab and then corrects itself.
 *
 * Registration is the fallback for a bar with no panels at all, which is a real
 * shape: a filter row driving a list somewhere else. The two can never disagree,
 * because the second is only consulted when the first is empty.
 */
export function resolveTabOrder(contentValues: readonly string[], registeredValues: readonly string[]): string[] {
	return contentValues.length > 0 ? [...contentValues] : [...registeredValues];
}

/**
 * Where a value sits in the order, or `-1` when nothing claims it.
 *
 * `-1` rather than 0 so a `value` naming a tab that does not exist is detectable
 * instead of silently selecting the first one.
 */
export function resolveTabIndex(order: readonly string[], value: string | null | undefined): number {
	if (value === null || value === undefined) return -1;
	return order.indexOf(value);
}

/**
 * What an uncontrolled `Tabs` starts on.
 *
 * The first tab, so a bar is never mounted with nothing selected and an indicator
 * with nowhere to sit.
 *
 * An explicit `null` is a value rather than an absence, so `defaultValue={null}`
 * starts the bar with nothing selected — the rule `pressedScale` already follows.
 * Only an omitted default falls through to the first tab.
 */
export function resolveInitialValue(order: readonly string[], defaultValue: string | null | undefined): string | null {
	if (defaultValue !== undefined) return defaultValue;
	return order[0] ?? null;
}

/** Whether a selection is a real change. A re-press of the current tab is not. */
export function shouldEmitTabChange(current: string | null, next: string): boolean {
	return current !== next;
}

/**
 * The interpolation tracks, or `null` while any tab is still unmeasured.
 *
 * All-or-nothing on purpose. A partially measured bar would put an `x` of 0 and a
 * `width` of 0 in the middle of the track, and the indicator would collapse to
 * nothing every time `position` crossed that tab — visible for exactly the frame
 * or two before the missing trigger lays out, which is the hardest kind of bug to
 * catch on a simulator. `null` means "draw nothing yet".
 *
 * A single tab is padded to a two-point range: `interpolate` needs at least two,
 * and handling that in the worklet instead would put a branch on the hot path for
 * a case that is settled once, here, at layout time.
 */
export function resolveMeasurementTracks(
	order: readonly string[],
	measured: Readonly<Record<string, TabMeasurement>>
): TabTracks | null {
	if (order.length === 0) return null;

	const first = measured[order[0]];
	if (!first) return null;

	if (order.length === 1) {
		return { index: [0, 1], width: [first.width, first.width], x: [first.x, first.x] };
	}

	const index: number[] = [];
	const width: number[] = [];
	const x: number[] = [];

	for (let i = 0; i < order.length; i++) {
		const measurement = measured[order[i]];
		if (!measurement) return null;
		index.push(i);
		width.push(measurement.width);
		x.push(measurement.x);
	}

	return { index, width, x };
}

/**
 * Whether the measured triggers sit left to right in the order the panels do.
 *
 * A caller who writes `Tabs.Content` in one order and `Tabs.Trigger` in another
 * gets an indicator that lands on the wrong tab, with nothing in the source to
 * point at. Every trigger sharing an `x` of 0 catches the other shape — a trigger
 * wrapped in a `View`, whose `onLayout` reports coordinates relative to that
 * wrapper rather than to the row.
 *
 * Development only; the root warns by name. This is `Radio`'s move for a
 * convention no type can express: check it where it *is* expressible.
 */
export function isTriggerOrderConsistent(xs: readonly number[]): boolean {
	for (let i = 1; i < xs.length; i++) {
		if (xs[i] <= xs[i - 1]) return false;
	}
	return true;
}

/** How `position` should be brought back in line with React's selection. */
export type TabsReconcileMode = "jump" | "none" | "spring";

/**
 * Which repair a commit needs, if any.
 *
 * `jump` is the case a float index alone cannot see: the selected TAB did not
 * change, but the list did, so its index moved under it. Springing there would
 * slide the pager sideways for an edit the user did not make.
 *
 * `none` covers both the settled case and a controlled parent rejecting a change —
 * a rejected press must not animate.
 */
export function resolveReconcileMode(state: {
	selectedIndex: number;
	selectedValue: string | null;
	targetIndex: number;
	targetValue: string | null;
}): TabsReconcileMode {
	if (state.selectedIndex < 0) return "none";
	if (state.targetIndex === state.selectedIndex) return "none";
	if (state.targetValue !== null && state.targetValue === state.selectedValue) return "jump";
	return "spring";
}

/**
 * What a panel tells assistive technology.
 *
 * Every panel is mounted, so an unselected one is content a screen reader would
 * otherwise read and a finger could reach. The two platform props are one
 * decision, so they live in one place rather than being written out at the call
 * site where only one of them can be forgotten.
 */
export function resolveContentAccessibility(isSelected: boolean): {
	accessibilityElementsHidden: boolean;
	importantForAccessibility: "auto" | "no-hide-descendants";
} {
	return isSelected
		? { accessibilityElementsHidden: false, importantForAccessibility: "auto" }
		: { accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" };
}

/** The indices a separator sits between, `-1` for a value no tab claims. */
export function resolveSeparatorIndices(
	order: readonly string[],
	betweenValues: readonly [string, string]
): { left: number; right: number } {
	return { left: resolveTabIndex(order, betweenValues[0]), right: resolveTabIndex(order, betweenValues[1]) };
}

/**
 * A trigger's settled availability.
 *
 * `own ?? root ?? default` — `Checkbox`'s ladder, deliberately not
 * `Radio.Group`'s. A radio group puts itself first because escaping a disabled
 * form group is a bug; a tab bar's disabled state is transient chrome and the
 * per-trigger case is the common one, so it has to survive the bar-wide one being
 * set. `??` throughout and never `||`, so `isDisabled={false}` opts one trigger
 * out of a disabled bar.
 */
export function resolveTabsTriggerState(state: { own?: boolean; root?: boolean }): { isDisabled: boolean } {
	return { isDisabled: state.own ?? state.root ?? false };
}

/**
 * The pager row's offset for a given float index.
 *
 * Named rather than written inline because the sign convention lives in exactly
 * one place. Advancing to the next tab moves the row LEFT, so a positive
 * `position` is a negative translation — getting that backwards is the single
 * most likely bug in this component, and a test pins it.
 */
export function resolvePagerTranslate(position: number, pageWidth: number): number {
	"worklet";
	return -position * pageWidth;
}

/**
 * The index the drag started from, back-computed at the moment the pan activates.
 *
 * `translationX` is measured from **touch-down**, but a pan does not activate
 * until the finger has travelled `TABS_PAN.activateX`. Capturing the origin at
 * activation without accounting for that would apply the pre-activation travel
 * twice and jump the pager sideways on the first frame of every drag.
 *
 * The origin is therefore whatever value makes {@link resolvePanPosition} return
 * the pager's *current* position for the translation seen so far — so the drag
 * starts exactly where the pager already is, mid-spring or at rest.
 *
 * Self-contained, for the reason {@link resolvePanPosition} gives.
 */
export function resolvePanOrigin(position: number, translationX: number, pageWidth: number): number {
	"worklet";
	if (pageWidth <= 0) return position;
	return position + translationX / pageWidth;
}

/**
 * `position` while a finger is down.
 *
 * Past either end the drag meets resistance rather than a wall — UIScrollView's
 * own rubber band, expressed in index units, where the page width IS one unit so
 * the formula's width term falls out. A hard clamp was the alternative and it
 * reads as a bug: the panel stops dead under a finger that is still moving, which
 * every user reads as a dropped gesture rather than as an edge.
 *
 * Self-contained, and the clamp is written out rather than shared. A module-scope
 * worklet calling another one binds its closure at import time, in source order,
 * and ends up `undefined` on the UI thread — a crash no unit test sees, because
 * the JS thread resolves it perfectly. See AGENTS.md.
 */
export function resolvePanPosition(state: {
	count: number;
	pageWidth: number;
	startPosition: number;
	translationX: number;
}): number {
	"worklet";
	if (state.pageWidth <= 0 || state.count <= 0) return state.startPosition;

	const raw = state.startPosition - state.translationX / state.pageWidth;
	const max = state.count - 1;
	const give = TABS_PAN.overscroll;

	if (raw < 0) return -(1 - 1 / (-raw / give + 1)) * give;
	if (raw > max) return max + (1 - 1 / ((raw - max) / give + 1)) * give;
	return raw;
}

/**
 * Which tab the pager settles on when the finger lifts.
 *
 * Two rules, in order. A fling — anything past `TABS_PAN.flingVelocity` — carries
 * to the next tab in the direction of travel however little of the page it
 * covered, because a flick is an instruction rather than a drag, and it never
 * carries further than one tab however hard it is thrown. Otherwise the nearest
 * tab wins, which is `Math.round`.
 *
 * A disabled tab is stepped over rather than landed on, walking outward in the
 * direction of travel first and then back the other way. It stays in the ORDER —
 * its panel still exists and still holds an index — because pulling it out would
 * make every index depend on a state that can change at runtime.
 */
export function resolveSettleIndex(state: {
	count: number;
	isEnabled?: readonly boolean[];
	position: number;
	startIndex: number;
	velocity: number;
}): number {
	"worklet";
	const max = state.count - 1;
	if (max < 0) return 0;

	let target = Math.round(state.position);

	if (state.velocity >= TABS_PAN.flingVelocity) {
		target = Math.max(Math.ceil(state.position), state.startIndex + 1);
	} else if (state.velocity <= -TABS_PAN.flingVelocity) {
		target = Math.min(Math.floor(state.position), state.startIndex - 1);
	}

	if (target < 0) target = 0;
	if (target > max) target = max;

	const enabled = state.isEnabled;
	if (enabled?.[target] !== false) return target;

	// Outward from the tab the drag actually reached, trying the direction of
	// travel first so a forward swipe keeps going forward. Both candidates are
	// bounds-checked: past either end `enabled[i]` is `undefined`, which is not
	// `false`, so an unguarded read would settle on a tab that does not exist.
	const ahead = target >= state.startIndex ? 1 : -1;
	for (let offset = 1; offset <= max; offset++) {
		const forward = target + offset * ahead;
		if (forward >= 0 && forward <= max && enabled[forward] !== false) return forward;
		const backward = target - offset * ahead;
		if (backward >= 0 && backward <= max && enabled[backward] !== false) return backward;
	}
	return state.startIndex;
}

/**
 * How selected one tab is right now, 0 to 1, from where the pager sits.
 *
 * `1` when the pager is squarely on this tab, `0` once it is a whole tab away,
 * and linear in between — so two neighbours read `0.5` each at the midpoint of a
 * drag. This is what the label's colour crossfades on, and because `position` is
 * written by the pan *and* by the settle spring, one function covers a finger
 * dragging, a flick, and a plain tap without knowing which is happening.
 *
 * Distinct from {@link resolveVisualIndex}, which is a discrete swap for the
 * things that cannot fade — a composed `Icon` takes its colour as a resolved
 * value, not a style, so it has no way to be half way between two.
 *
 * Self-contained, for the reason {@link resolvePanPosition} gives.
 */
export function resolveTabSelectedness(index: number, position: number): number {
	"worklet";
	if (index < 0) return 0;
	const distance = Math.abs(position - index);
	if (distance >= 1) return 0;
	return 1 - distance;
}

/**
 * Which tab is VISUALLY current — the one the indicator mostly covers.
 *
 * Distinct from the settled index, and both names are needed. The settled index is
 * what a screen reader announces, what a panel hides on and what `onValueChange`
 * reported; this one is only what things are PAINTED from, and it changes the
 * moment a dragged capsule covers more of the next tab than the current one.
 *
 * Without it a capsule halfway across a drag carries the incoming label's
 * unselected colour on top of the fill it has already covered, which is
 * unreadable for the whole of the travel. `TABS_VISUAL_HYSTERESIS` is what keeps a finger held at the midpoint
 * from flipping it every frame.
 */
export function resolveVisualIndex(position: number, current: number, count: number): number {
	"worklet";
	const max = count - 1;
	if (max < 0) return 0;
	if (Math.abs(position - current) <= 0.5 + TABS_VISUAL_HYSTERESIS) return current;

	let next = Math.round(position);
	if (next < 0) next = 0;
	if (next > max) next = max;
	return next;
}

/**
 * How visible a separator is, given where the pager sits.
 *
 * A rule fades out only while the pager is **crossing** it, and is fully present
 * the rest of the time — including when the pager is parked on either of the two
 * tabs it sits between. So a bar at rest always shows every one of its rules, and
 * a drag dips the single rule it travels over and brings it back.
 *
 * The first shape of this hid every rule *flanking* the active tab, which is a
 * different thing and reads badly: on a three-tab bar it leaves exactly one rule
 * visible, over on the far side, looking arbitrary — and the set of visible rules
 * changed every time the tab did, so the bar never looked still. Measuring from
 * the gap's own midpoint instead makes the fade mean one thing: the capsule is
 * on top of this rule right now.
 *
 * Driven by `position` rather than by the settled value, so the rule retreats
 * under a finger and comes back if the drag is abandoned — which is the whole
 * reason it is an animation and not a conditional render.
 *
 * A pair naming a tab nothing claims returns 1: a separator that vanished for a
 * reason unexplainable from the call site would be worse than one that never
 * fades.
 *
 * Self-contained, for the reason {@link resolvePanPosition} gives.
 */
export function resolveSeparatorOpacity(position: number, leftIndex: number, rightIndex: number): number {
	"worklet";
	if (leftIndex < 0 || rightIndex < 0) return 1;

	const midpoint = (leftIndex + rightIndex) / 2;
	const distance = Math.abs(position - midpoint);

	const span = TABS_SEPARATOR_FADE.distance - TABS_SEPARATOR_FADE.hold;
	if (span <= 0) return distance > TABS_SEPARATOR_FADE.hold ? 1 : 0;

	const t = (distance - TABS_SEPARATOR_FADE.hold) / span;
	if (t < 0) return 0;
	if (t > 1) return 1;
	return t;
}

/**
 * Where the bar should sit so the active trigger lands as `align` says.
 *
 * `none` returns the offset unchanged rather than 0, so the prop means "leave the
 * bar alone" instead of "send it home" — the difference matters for a bar the user
 * has scrolled by hand.
 *
 * `start` and `end` leave `TABS_SCROLL_INSET` of the neighbouring tab visible. A
 * trigger flush against the viewport edge reads as the last one in the list, and a
 * sliver of the next is the only thing that says otherwise.
 *
 * Both clamps are written out rather than shared, for the reason
 * `resolvePanPosition` gives.
 */
export function resolveScrollOffset(state: {
	align: TabsScrollAlign;
	contentWidth: number;
	currentOffset: number;
	viewportWidth: number;
	width: number;
	x: number;
}): number {
	"worklet";
	if (state.align === "none") return state.currentOffset;
	if (state.viewportWidth <= 0) return state.currentOffset;

	const max = state.contentWidth - state.viewportWidth;
	if (max <= 0) return 0;

	let target: number;
	if (state.align === "center") {
		target = state.x + state.width / 2 - state.viewportWidth / 2;
	} else if (state.align === "end") {
		target = state.x + state.width - state.viewportWidth + TABS_SCROLL_INSET;
	} else {
		target = state.x - TABS_SCROLL_INSET;
	}

	if (target < 0) return 0;
	if (target > max) return max;
	return target;
}

/**
 * Styling for every part of a tab bar, and for the panels below it.
 *
 * One slotted `tv()` rather than a call per part, because `tabs-indicator.tsx`,
 * `tabs-trigger.tsx` and the rest cannot import the root without closing a cycle
 * (AGENTS.md rule 3) yet all of them read the same `variant` and `size`.
 *
 * **The `indicator` slot names no width, offset or transform, at any size.** All
 * three are an animated style, and a class fighting a `useAnimatedStyle` for the
 * same property is an indicator that never appears, with no error anywhere.
 *
 * **The `trigger` slot carries no `opacity-*`, in any cell.** The disabled fade
 * lands on the label instead. `Pressable` now multiplies a className's opacity
 * into its press, so a fade on the trigger would draw — but the label already
 * fades, and the two would compound to a quarter. This is `Radio`'s arrangement.
 *
 * **Selection changes the label's colour and nothing else.** A weight change would
 * re-measure the label, which moves the frame the indicator is sitting on, on
 * every single tap. A test asserts the two class sets differ by exactly one
 * `text-*`.
 *
 * **The trigger's height is a floor, never fixed.** `Text` respects OS font
 * scaling, so an `h-*` would clip a label at a large accessibility step; unlike a
 * button or a field, a tab lines up against no chrome that would force the number.
 * That is also why no `--spacing-tabs-*` is minted — it would be three numbers to
 * retune in step with three others forever, `Checkbox`'s argument against
 * `--spacing-checkbox-*`.
 *
 * **`page` is `w-full shrink-0`, and both halves are load-bearing.** `w-full`
 * resolves against the row, which is the viewport's width, so the pages are laid
 * out correctly on the FIRST paint with nothing measured; a row sized from a
 * measurement would show every panel collapsed to zero width for a commit.
 * `shrink-0` is what stops flex shrinking eight overflowing panels to an eighth
 * each.
 *
 * Free of React Native imports so it stays unit-testable — `bun test` cannot parse
 * React Native's Flow-typed source. See AGENTS.md.
 */
export const tabsVariants = tv({
	slots: {
		/** The component's column: the bar, then the panels. */
		root: "",
		/** The track. Paints a surface on `primary` alone. Clips, so the capsule cannot round its own corners past it. */
		list: "overflow-hidden",
		/** The horizontal scroller's own box. Never grows — the bar is as tall as its row. */
		scroll: "grow-0",
		/** The trigger row. Worn by `Tabs.List`, or by the scroller's content container. */
		row: "flex-row items-stretch",
		/** The one sliding layer. Its offset and width are an animated style, never a class. */
		indicator: "absolute",
		/** The pressable. Paints no surface — the indicator does. */
		trigger: "flex-row items-center justify-center",
		/**
		 * Handed to a `Text.Label`. Layout only — no scale, and no colour.
		 *
		 * The colour is an animated style rather than a class, because it *fades*:
		 * it interpolates between the two values {@link TABS_FOREGROUND_TOKEN}
		 * names, off the same `position` everything else in the component reads. A
		 * class here would be a second source for one colour, and a class and a
		 * style disagreeing for a frame is exactly what `Checkbox`'s animated border
		 * exists to avoid.
		 */
		label: "shrink",
		/** Published to any glyph composed into a trigger, so a bare `Icon` needs nothing said. */
		icon: "",
		/**
		 * Positioning for a vertical rule. The line itself is a `Separator`.
		 *
		 * `flex-row` is load-bearing and its absence is silent. A vertical
		 * `Separator` is `self-stretch w-px`, so it takes its length from the cross
		 * axis of whatever holds it — in a column that axis is horizontal, and the
		 * rule comes out full width and zero height, which draws nothing at all.
		 */
		separator: "flex-row self-center",
		/** The pager's viewport. */
		pager: "overflow-hidden",
		/** The row of panels the pager translates. */
		pageRow: "flex-row items-stretch",
		/** One panel, exactly one viewport wide. */
		page: "w-full shrink-0",
	},
	variants: {
		variant: {
			primary: { list: "rounded-full bg-muted", indicator: "inset-y-0 rounded-full bg-elevated" },
			secondary: { indicator: "bottom-0 h-0.5 rounded-full bg-primary" },
		},
		size: {
			sm: { root: "gap-3", row: "gap-1.5", trigger: "min-h-9 gap-1 px-3", separator: "h-4", icon: "size-icon-sm" },
			md: { root: "gap-4", row: "gap-2", trigger: "min-h-11 gap-1.5 px-4", separator: "h-5", icon: "size-icon-md" },
			lg: { root: "gap-5", row: "gap-2.5", trigger: "min-h-12 gap-2 px-5", separator: "h-6", icon: "size-icon-lg" },
		},
		// The empty branches are load-bearing typing, not placeholders. `tv` derives
		// the prop type from the declared keys, so a map with only `true` types the
		// prop as `true` rather than `boolean`. See button.variants.ts.
		//
		// A trigger fills the bar when the row does not scroll and sizes to its own
		// content when it does. `flex-1` inside a scroller would set a basis of 0%,
		// which Yoga resolves to zero in a content-sized row — the same collapse
		// `Radio`'s label avoids by taking `shrink` rather than `flex-1`.
		isScrollable: { true: {}, false: { trigger: "flex-1" } },
		isDisabled: { true: { label: "opacity-50" }, false: {} },
	},
	compoundVariants: [
		// The track's padding belongs to the variant that draws a track: carried on
		// `size` alone it would inset an underline that has no track to sit in. The
		// corner is not here — both the track and the capsule are `rounded-full` on
		// the variant itself, at every size.
		{ variant: "primary", size: "sm", class: { list: "p-0.5" } },
		{ variant: "primary", size: "md", class: { list: "p-1" } },
		{ variant: "primary", size: "lg", class: { list: "p-1" } },
	],
	defaultVariants: {
		variant: TABS_DEFAULT_VARIANT,
		size: TABS_DEFAULT_SIZE,
		isScrollable: false,
		isDisabled: false,
	},
});

export type TabsVariantProps = VariantProps<typeof tabsVariants>;
