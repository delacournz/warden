import type { VariantProps } from "tailwind-variants";
import { tv } from "@/lib/tv";
import type { TextSize } from "@/components/ui/text/text.variants";

/**
 * How an indicator is painted. `primary` rings the current step and leaves the
 * steps ahead hollow; `secondary` fills every indicator, the current one solid
 * and the rest soft.
 */
export const STEPS_VARIANTS = ["primary", "secondary"] as const;

export const STEPS_SIZES = ["sm", "md", "lg"] as const;

/** Which way the steps run. `horizontal` puts titles under the indicators; `vertical` beside them. */
export const STEPS_ORIENTATIONS = ["horizontal", "vertical"] as const;

/** Where a step stands relative to the value. See {@link resolveStepStatus}. */
export const STEP_STATUSES = ["completed", "current", "upcoming"] as const;

export type StepsVariant = (typeof STEPS_VARIANTS)[number];
export type StepsSize = (typeof STEPS_SIZES)[number];
export type StepsOrientation = (typeof STEPS_ORIENTATIONS)[number];
export type StepStatus = (typeof STEP_STATUSES)[number];

/**
 * The axes a stepper falls back to when the call site names none.
 *
 * Named once because two places read them — `defaultVariants` below and the
 * root's destructure, which settles them before `tv` is ever called and
 * publishes them through context. A test pins the pair.
 */
export const STEPS_DEFAULT_VARIANT: StepsVariant = "primary";
export const STEPS_DEFAULT_SIZE: StepsSize = "md";
export const STEPS_DEFAULT_ORIENTATION: StepsOrientation = "horizontal";

/**
 * The `Text` size step each stepper size hands `Steps.Title`.
 *
 * The title renders `Text.Label` and names this step rather than restating a
 * type scale in a slot — the rule `Radio.Label` follows. The vertical layout's
 * top padding is derived from the line height of this step, and a test holds
 * the two together: move one without the other and the title's first line
 * stops sitting level with its indicator.
 */
export const STEPS_TITLE_TEXT_SIZE: Record<StepsSize, TextSize> = { sm: "sm", md: "md", lg: "lg" };

/** The `Text` size step each stepper size hands `Steps.Description`. One below the title. */
export const STEPS_DESCRIPTION_TEXT_SIZE: Record<StepsSize, TextSize> = { sm: "xs", md: "sm", lg: "md" };

/**
 * Styling for every part of a stepper.
 *
 * One slotted `tv()` rather than a call per part, because the item, indicator,
 * title and description files cannot import the root without closing a cycle
 * (AGENTS.md rule 3) yet all of them read the same `orientation`, `size` and
 * `status`.
 *
 * **The connectors are laid out, never measured.** A horizontal item is a
 * column of equal `flex-1` width with its indicator centred in a track of
 * `[half-line] [indicator] [half-line]`; the line between two steps is the
 * right half of one and the left half of the next, meeting at the item
 * boundary. A vertical trigger is a row whose track is `[indicator] [line]`, the
 * line `flex-1` down the height the content gives it. Neither needs an
 * `onLayout`, so a title that wraps to three lines moves nothing a frame late.
 *
 * **A vertical title is padded down to sit level with its indicator**, by half
 * the difference between the indicator's edge and the title's line height —
 * the one number here derived from another, and pinned by a test.
 *
 * **The fade lands on the indicator and the content, never the trigger.** The
 * trigger is worn by `Pressable`'s own `Animated.View`, whose animated style writes
 * `opacity` every frame and would silently overwrite an `opacity-50` class —
 * the trap `radioVariants` documents.
 *
 * Every colour cell lives in `compoundVariants`, invalid last, because `tv`
 * emits the compounds after the plain variants: a plain `isInvalid` branch
 * would lose to the status cells.
 *
 * Free of React Native imports so it stays unit-testable. See AGENTS.md.
 */
export const stepsVariants = tv({
	slots: {
		/** The root's box. */
		root: "w-full",
		/** One step's box: the trigger, then its panel. Takes the caller's `className`. */
		item: "",
		/** The pressable — indicator, title and description. Deliberately free of opacity; see above. */
		trigger: "",
		/** The indicator and the connector halves around it. */
		track: "",
		/**
		 * One half of the line between two steps. Square-ended: two rounded
		 * halves meeting at the item boundary would pinch the line there.
		 */
		connector: "",
		/** An invisible half that keeps an end indicator centred in its column. */
		spacer: "flex-1",
		/** The circle. */
		indicator: "items-center justify-center rounded-full border-2",
		/** The step number inside the circle — a `Text`, so it owns its colour (rule 1). */
		indicatorLabel: "font-semibold",
		/** The check, alert or spinner inside the circle. */
		glyph: "",
		/** The title, description and anything else composed into the step. */
		content: "min-w-0 gap-0.5",
		/** Handed to a `Text.Label`. */
		title: "",
		/** Handed to a `Text.Caption`. */
		description: "",
		/** `Steps.Panel`'s row: a rail carrying the line on, and the panel beside it. */
		panelRow: "",
		/** The column under the indicator that carries a vertical line past a panel. */
		rail: "items-center",
		/** `Steps.Panel` itself — outside the tap target. */
		panel: "min-w-0",
	},
	variants: {
		orientation: {
			horizontal: {
				root: "flex-row items-start",
				item: "flex-1",
				trigger: "items-center",
				track: "flex-row items-center self-stretch",
				connector: "h-0.5 flex-1",
				content: "items-center px-1",
				panel: "px-1 pt-2",
				title: "text-center",
				description: "text-center",
			},
			vertical: {
				root: "flex-col",
				trigger: "flex-row",
				track: "items-center",
				panelRow: "flex-row",
				panel: "flex-1",
				connector: "min-h-4 w-0.5 flex-1",
				content: "flex-1",
			},
		},
		size: {
			sm: {
				trigger: "gap-2",
				panelRow: "gap-2",
				rail: "w-6",
				track: "gap-1",
				indicator: "size-6",
				indicatorLabel: "text-xs",
				glyph: "size-icon-sm",
			},
			md: {
				trigger: "gap-2.5",
				panelRow: "gap-2.5",
				rail: "w-8",
				track: "gap-1.5",
				indicator: "size-8",
				indicatorLabel: "text-sm",
				glyph: "size-icon-lg",
			},
			lg: {
				trigger: "gap-3",
				panelRow: "gap-3",
				rail: "w-10",
				track: "gap-2",
				indicator: "size-10",
				indicatorLabel: "text-base",
				glyph: "size-icon-xl",
			},
		},
		// The empty branches are load-bearing typing, not placeholders — `tv`
		// derives the prop type from the declared keys. See button.variants.ts.
		variant: { primary: {}, secondary: {} },
		status: {
			completed: { title: "text-foreground" },
			current: { title: "text-foreground" },
			upcoming: { title: "text-muted-foreground" },
		},
		isInvalid: { true: {}, false: {} },
		isConnectorComplete: { true: { connector: "bg-primary" }, false: { connector: "bg-border" } },
		isDisabled: { true: { indicator: "opacity-50", content: "opacity-50" }, false: {} },
		isLast: { true: {}, false: {} },
		hasPanel: { true: {}, false: {} },
	},
	compoundVariants: [
		// A vertical step's content: level with the indicator at the top, and
		// room below for the line to run down to the next step.
		{ orientation: "vertical", size: "sm", class: { content: "pt-0.5" } },
		{ orientation: "vertical", size: "md", class: { content: "pt-1" } },
		{ orientation: "vertical", size: "lg", class: { content: "pt-1.5" } },
		{ orientation: "vertical", isLast: false, size: "sm", class: { content: "pb-4" } },
		{ orientation: "vertical", isLast: false, size: "md", class: { content: "pb-6" } },
		{ orientation: "vertical", isLast: false, size: "lg", class: { content: "pb-8" } },
		{ orientation: "vertical", isLast: true, class: { content: "pb-0" } },
		// The line stops short of the next indicator by the same gap it leaves
		// below its own, so it floats between the two rather than touching one.
		{ orientation: "vertical", size: "sm", class: { track: "pb-1" } },
		{ orientation: "vertical", size: "md", class: { track: "pb-1.5" } },
		{ orientation: "vertical", size: "lg", class: { track: "pb-2" } },
		// With a panel both gaps move down a row: the trigger's line runs to its
		// bottom edge and on through the rail, and the space before the next step
		// opens below the panel instead of below the title.
		{ orientation: "vertical", hasPanel: true, class: { content: "pb-0", track: "pb-0" } },
		{ orientation: "vertical", hasPanel: true, isLast: false, size: "sm", class: { panel: "pb-4", rail: "pb-1" } },
		{ orientation: "vertical", hasPanel: true, isLast: false, size: "md", class: { panel: "pb-6", rail: "pb-1.5" } },
		{ orientation: "vertical", hasPanel: true, isLast: false, size: "lg", class: { panel: "pb-8", rail: "pb-2" } },

		{
			variant: "primary",
			status: "completed",
			class: { indicator: "border-primary bg-primary", indicatorLabel: "text-primary-foreground" },
		},
		{
			variant: "primary",
			status: "current",
			class: { indicator: "border-primary bg-transparent", indicatorLabel: "text-foreground" },
		},
		{
			variant: "primary",
			status: "upcoming",
			class: { indicator: "border-border bg-transparent", indicatorLabel: "text-muted-foreground" },
		},
		{
			variant: "secondary",
			status: "completed",
			class: { indicator: "border-secondary bg-secondary", indicatorLabel: "text-secondary-foreground" },
		},
		{
			variant: "secondary",
			status: "current",
			class: { indicator: "border-primary bg-primary", indicatorLabel: "text-primary-foreground" },
		},
		{
			variant: "secondary",
			status: "upcoming",
			class: { indicator: "border-muted bg-muted", indicatorLabel: "text-muted-foreground" },
		},
		{
			isInvalid: true,
			class: {
				indicator: "border-destructive bg-destructive",
				indicatorLabel: "text-destructive-foreground",
				title: "text-destructive",
			},
		},
	],
	defaultVariants: {
		orientation: STEPS_DEFAULT_ORIENTATION,
		size: STEPS_DEFAULT_SIZE,
		variant: STEPS_DEFAULT_VARIANT,
		status: "upcoming",
		isInvalid: false,
		isConnectorComplete: false,
		isDisabled: false,
		isLast: false,
		hasPanel: false,
	},
});

export type StepsVariantProps = VariantProps<typeof stepsVariants>;

/**
 * The theme token an indicator's contents are drawn in.
 *
 * The number is a `Text` and takes its colour as a class from the
 * `indicatorLabel` slot; the check, the alert and the spinner are SVG and take
 * theirs as a token through `IconDefaultsProvider`. Two mechanisms for one
 * decision, so a test asserts every cell of this map is the class the slot
 * emits — a drift would be a white number beside a black check.
 */
export function resolveIndicatorForeground({
	variant,
	status,
	isInvalid,
}: {
	variant: StepsVariant;
	status: StepStatus;
	isInvalid: boolean;
}): string {
	if (isInvalid) return "destructive-foreground";
	if (status === "upcoming") return "muted-foreground";
	if (variant === "primary") return status === "completed" ? "primary-foreground" : "foreground";
	return status === "completed" ? "secondary-foreground" : "primary-foreground";
}

/**
 * Where a step stands, from its index, the stepper's value and its own override.
 *
 * Before the value is `completed`, at it is `current`, after it `upcoming`.
 * `completed: true` wins everywhere — a finished flow marks its last step done
 * while still sitting on it. `completed: false` un-completes a step the value
 * has passed (a skipped optional step) but never demotes the current one, which
 * would leave a stepper with nowhere the user is.
 *
 * Pure, so the whole matrix is reachable from `bun test`.
 */
export function resolveStepStatus({
	step,
	value,
	completed,
}: {
	step: number;
	value: number;
	completed?: boolean;
}): StepStatus {
	if (completed === true) return "completed";
	if (step === value) return "current";
	if (completed === false) return "upcoming";
	return step < value ? "completed" : "upcoming";
}

/**
 * Whether the line leaving `step` is filled.
 *
 * Read off the value alone, never off either step's status: the line is drawn
 * as two halves in two different items, and each half can see only its own
 * step's overrides. The value is the one thing both ends agree on.
 */
export function isConnectorComplete(step: number, value: number): boolean {
	return step < value;
}

/** What one side of an indicator's track holds. */
export type StepConnectorSlot = "line" | "spacer" | "none";

/**
 * Which connector halves a step draws.
 *
 * Horizontal steps always draw both sides so every indicator stays centred in
 * its equal-width column — the outer ends become transparent spacers rather
 * than disappearing. Vertical steps draw one line down from the indicator, and
 * none from the last.
 *
 * This is how the connectors are "drawn for you": the root counts its items,
 * so no caller places a separator, and none can be left dangling after the
 * last step.
 */
export function resolveStepConnectors({
	step,
	count,
	orientation,
}: {
	step: number;
	count: number;
	orientation: StepsOrientation;
}): { leading: StepConnectorSlot; trailing: StepConnectorSlot } {
	const isFirst = step <= 0;
	const isLast = step >= count - 1;
	if (orientation === "vertical") return { leading: "none", trailing: isLast ? "none" : "line" };
	return { leading: isFirst ? "spacer" : "line", trailing: isLast ? "spacer" : "line" };
}

/**
 * Whether the stepper takes presses at all.
 *
 * A controlled `value` with no `onValueChange` is a progress display: nothing a
 * press could do would stick, so its steps render as plain views and are not
 * announced as buttons. `isReadOnly` states it outright either way.
 */
export function resolveStepsReadOnly({
	isControlled,
	hasOnValueChange,
	isReadOnly,
}: {
	isControlled: boolean;
	hasOnValueChange: boolean;
	isReadOnly?: boolean;
}): boolean {
	return isReadOnly ?? (isControlled && !hasOnValueChange);
}

/**
 * How one step responds to touch.
 *
 * `static` renders a plain view — the stepper is read-only. `pressable` moves the
 * value there. `blocked` is still a pressable, announced disabled: the step is
 * disabled, loading, or ahead of the value in a linear flow, where the only way
 * forward is the flow's own Continue button.
 */
export type StepInteraction = "static" | "pressable" | "blocked";

export function resolveStepInteraction({
	isReadOnly,
	isLinear,
	isDisabled,
	isLoading,
	step,
	value,
}: {
	isReadOnly: boolean;
	isLinear: boolean;
	isDisabled: boolean;
	isLoading: boolean;
	step: number;
	value: number;
}): StepInteraction {
	if (isReadOnly) return "static";
	if (isDisabled || isLoading) return "blocked";
	if (isLinear && step > value) return "blocked";
	return "pressable";
}

/**
 * Whether a press should write a new value. Re-pressing the current step is not
 * a change, so the caller is never re-notified with the value it already holds.
 */
export function shouldEmitStep(current: number, next: number): boolean {
	return current !== next;
}

const STATUS_WORD: Record<StepStatus, string> = { completed: "completed", current: "current", upcoming: "upcoming" };

/**
 * What VoiceOver and TalkBack read after a step's title.
 *
 * Handed to `accessibilityValue.text`, so the title stays the accessible name
 * and this follows it: "Payment, Step 2 of 3, completed". One-based, because
 * that is what the indicator draws. A count of zero means the root found no
 * items to count — they sit behind a wrapper — and "of 0" would be a lie.
 */
export function resolveStepAccessibilityValue({
	step,
	count,
	status,
	isInvalid = false,
	isLoading = false,
}: {
	step: number;
	count: number;
	status: StepStatus;
	isInvalid?: boolean;
	isLoading?: boolean;
}): string {
	const position = count > 0 ? `Step ${step + 1} of ${count}` : `Step ${step + 1}`;
	const parts = [position, STATUS_WORD[status]];
	if (isInvalid) parts.push("has an error");
	if (isLoading) parts.push("loading");
	return parts.join(", ");
}

/** What the indicator draws inside its circle. */
export type StepIndicatorGlyph =
	| { kind: "spinner" }
	| { kind: "alert" }
	| { kind: "check" }
	| { kind: "number"; label: string };

/**
 * What an indicator draws: a spinner while loading, an alert while invalid, a
 * check once completed, and otherwise the step's one-based number.
 *
 * Loading outranks invalid because it is the more recent fact — a step that
 * failed and is being retried is retrying.
 */
export function resolveIndicatorGlyph({
	step,
	status,
	isInvalid,
	isLoading,
}: {
	step: number;
	status: StepStatus;
	isInvalid: boolean;
	isLoading: boolean;
}): StepIndicatorGlyph {
	if (isLoading) return { kind: "spinner" };
	if (isInvalid) return { kind: "alert" };
	if (status === "completed") return { kind: "check" };
	return { kind: "number", label: String(step + 1) };
}
