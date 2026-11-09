import type { VariantProps } from "tailwind-variants";
import { cn } from "@/lib/cn";
import { tv } from "@/lib/tv";
import type { ButtonGroupOrientation, ButtonGroupSlotPosition, ButtonSize } from "@/components/ui/button/button.variants";

export const INPUT_VARIANTS = ["primary", "secondary", "etched"] as const;

export const INPUT_SIZES = ["sm", "md", "lg"] as const;

export type InputVariant = (typeof INPUT_VARIANTS)[number];
export type InputSize = (typeof INPUT_SIZES)[number];

/**
 * Where a part of a group sits: inside a row — the field's row, or a block's —
 * or directly in the box, between a block and the row.
 */
export const INPUT_GROUP_PLACEMENTS = ["row", "box"] as const;

export type InputGroupPlacement = (typeof INPUT_GROUP_PLACEMENTS)[number];

/** Theme token an icon in a decorator inherits, and the one it takes when invalid. */
export const INPUT_DECORATOR_ICON_TOKEN = "muted-foreground";
export const INPUT_INVALID_DECORATOR_ICON_TOKEN = "destructive";

/**
 * Default colours for the three `TextInput` props that take a colour rather
 * than a style — the placeholder, and the caret and selection highlight.
 *
 * These are `accent-*` utilities, not `text-*` ones, and that is not a style
 * choice. Uniwind bridges a className to one of these props by compiling it and
 * reading `styles.accentColor`, so a class that sets any other property
 * resolves to nothing: uniwind warns once in development and the prop is left
 * undefined, which reads as "the platform default" rather than as an error.
 */
export const INPUT_PLACEHOLDER_ACCENT_CLASS = "accent-muted-foreground";
export const INPUT_SELECTION_ACCENT_CLASS = "accent-primary";
export const INPUT_INVALID_SELECTION_ACCENT_CLASS = "accent-destructive";

/**
 * Styling for every part of a text field.
 *
 * One slotted `tv()` rather than a call per part, so `size` and `variant` are
 * declared once — and, more importantly here, so the box is declared once. The
 * `root` slot is the whole bordered box, and it lands on the `TextInput` when
 * the field stands alone or on `Input.Group`'s row when it does not. That is
 * what makes a grouped field identical to a lone one by construction rather
 * than by two class strings happening to agree; it holds
 * as a property over every combination of the axes.
 *
 * `root` therefore holds no `text-*` utility. When the field is grouped that
 * slot is worn by a `View`, and a React Native `View` does not cascade colour
 * to a `Text` descendant — so the type scale and the colour live on `field`,
 * which is always the `TextInput` itself. See AGENTS.md rule 1.
 *
 * A size names tokens rather than raw utilities: `h-input-md` for the box,
 * `text-input-md` for the value, `size-icon-md` for a decorator's glyph. The
 * values live in `tokens.css`, so a field and the icon inside it resolve
 * against one scale rather than two numbers happening to agree. `cn` and `tv`
 * both have to know these token names — see `lib/cn.ts` and `styles/tokens.ts`.
 *
 * Prefix and suffix share the one `decorator` slot. They are the same box in
 * different places, and a second identical slot is a second definition that can
 * drift.
 *
 * Free of React Native imports so it stays unit-testable — it must not
 * pull in React Native's Flow-typed source. See AGENTS.md.
 */
export const inputVariants = tv({
	slots: {
		root: "overflow-hidden border",
		/*
		 * Layout for the group's inner row, which holds the decorators and the
		 * field. Never applied to a lone field, which is not a row. `grow` rather
		 * than `flex-1`: a zero flex-basis collapses inside a box with no fixed
		 * height, which is exactly the box a block leaves behind.
		 */
		row: "grow flex-row items-center",
		/** A full-width section above or below the row. The box supplies its horizontal inset. */
		block: "flex-row flex-wrap items-center",
		/** A hairline between a decorator and the field, or between a block and the row. */
		separator: "bg-border",
		/*
		 * The one text surface in this package that is not a `Text`: a raw React
		 * Native `TextInput`, which inherits nothing. `font-sans` is restated for
		 * the same reason `TEXT_BASE_CLASS` carries it — without it a themed
		 * typeface would stop at the field's edge.
		 */
		field: "font-sans text-foreground",
		decorator: "items-center justify-center",
		/** Edge length an `Icon` in a decorator inherits. */
		decoratorIcon: "",
		/** Treatment a bare `Text` affix in a decorator inherits. */
		decoratorText: "text-muted-foreground",
	},
	variants: {
		variant: {
			primary: { root: "border-input bg-card" },
			secondary: { root: "border-transparent bg-secondary" },
			// The card fill with the highlight set into its edge. Focus swaps
			// that for a ring border and a three-point halo — see the compound.
			etched: { root: "border-input bg-card shadow-etched dark:shadow-etched-dark" },
		},
		size: {
			sm: {
				root: "px-2.5",
				row: "gap-1.5",
				block: "gap-1.5 py-1",
				field: "text-input-sm leading-tight",
				decoratorIcon: "size-icon-sm",
				decoratorText: "text-input-sm",
			},
			md: {
				root: "px-3",
				row: "gap-2",
				block: "gap-2 py-1.5",
				field: "text-input-md leading-tight",
				decoratorIcon: "size-icon-md",
				decoratorText: "text-input-md",
			},
			lg: {
				root: "px-3.5",
				row: "gap-2.5",
				block: "gap-2.5 py-2",
				field: "text-input-lg leading-tight",
				decoratorIcon: "size-icon-lg",
				decoratorText: "text-input-lg",
			},
		},
		// The empty `false` branches are load-bearing typing, not placeholders.
		// `tv` derives the prop type from the declared keys, so a map with only
		// `true` types the prop as `true` rather than `boolean` and rejects
		// `inputVariants({ isFocused })`. See button.variants.ts for the same note.
		isFocused: { true: { root: "border-ring" }, false: {} },
		isInvalid: { true: { root: "border-destructive", decoratorText: "text-destructive" }, false: {} },
		/**
		 * Which way a separator runs, read from where it sits: across a row it is
		 * vertical, between the box's sections it is horizontal.
		 */
		placement: {
			row: { separator: "my-2 w-px self-stretch" },
			box: { separator: "h-px self-stretch" },
		},
		/**
		 * Which edge of the box a block sits on. `none` is everything that is
		 * not a block.
		 */
		blockPosition: { none: {}, start: {}, end: {} },
		isDisabled: { true: { root: "opacity-50" }, false: {} },
		isMultiline: { true: {}, false: {} },
		// A grouped field shares its row, so it stretches — and it clears React
		// Native's own padding, which on Android would otherwise inset the value
		// from a gutter the row has already applied.
		isGrouped: { true: { field: "flex-1 p-0" }, false: {} },
		/** Which way an enclosing `Button.Group` runs, when there is one. */
		orientation: { horizontal: {}, vertical: {} },
		// A field standing on its own is `none` and keeps the corner off the
		// generic ramp. Every other value means it is joined, and a joined
		// control takes the group's corner rather than its own — see the note on
		// the corner compounds below.
		groupPosition: { none: {}, first: {}, middle: { root: "rounded-none" }, last: {}, only: {} },
		isSeamed: { true: {}, false: {} },
	},
	compoundVariants: [
		// The height and the vertical rhythm are declared together rather than
		// fighting each other in the merge, the way a button's square footprint
		// and its horizontal padding are.
		//
		// `py-0` on a single-line field is load-bearing on Android: React
		// Native's `TextInput` inherits the platform's own vertical padding,
		// which would push the value off centre inside a fixed height.
		{ isMultiline: false, size: "sm", class: { root: "h-input-sm py-0" } },
		{ isMultiline: false, size: "md", class: { root: "h-input-md py-0" } },
		{ isMultiline: false, size: "lg", class: { root: "h-input-lg py-0" } },
		// A multiline field grows with its text, so the height becomes a floor.
		// The row aligns to the top with it: centred decorators would drift down
		// the side of a paragraph instead of sitting on its first line.
		{ isMultiline: true, size: "sm", class: { root: "min-h-input-sm py-2", row: "items-start" } },
		{ isMultiline: true, size: "md", class: { root: "min-h-input-md py-2.5", row: "items-start" } },
		{ isMultiline: true, size: "lg", class: { root: "min-h-input-lg py-3", row: "items-start" } },
		// Focus is transient and invalid is reported, so invalid outranks it. A
		// field that went grey the moment it was tapped would drop the only
		// signal it has that its value is wrong, exactly while it is being fixed.
		{ isFocused: true, isInvalid: true, class: { root: "border-destructive" } },
		// An etched field trades its edge highlight for the halo while it holds
		// focus. Invalid keeps the highlight and the destructive border instead,
		// so a wrong value never glows in the ring's colour.
		{
			isFocused: true,
			isInvalid: false,
			variant: "etched",
			class: { root: "border-ring shadow-focus dark:shadow-focus-dark" },
		},
		// A horizontal hairline bleeds out by exactly the box's inset, so it
		// meets the border on both sides rather than stopping short of it.
		{ placement: "box", size: "sm", class: { separator: "-mx-2.5" } },
		{ placement: "box", size: "md", class: { separator: "-mx-3" } },
		{ placement: "box", size: "lg", class: { separator: "-mx-3.5" } },
		// A block bleeds out through the box's vertical padding on its outer
		// edge, the way a horizontal hairline bleeds through the horizontal. That
		// padding is the field's breathing room; stacked on the block's own it
		// set a toolbar half again as far from the border as from its separator,
		// and left the same slack under a footer. Each value is the multiline
		// `py-*` above, so the block's own padding is all there is either side.
		{ blockPosition: "start", size: "sm", class: { block: "-mt-2" } },
		{ blockPosition: "start", size: "md", class: { block: "-mt-2.5" } },
		{ blockPosition: "start", size: "lg", class: { block: "-mt-3" } },
		{ blockPosition: "end", size: "sm", class: { block: "-mb-2" } },
		{ blockPosition: "end", size: "md", class: { block: "-mb-2.5" } },
		{ blockPosition: "end", size: "lg", class: { block: "-mb-3" } },
		// The corner a lone field draws: the generic ramp, deliberately not the
		// button's, because a field and the button beside it are meant to be
		// retunable apart. `sm` steps down a notch; the other two share `lg`.
		{ groupPosition: "none", size: "sm", class: { root: "rounded-md" } },
		{ groupPosition: "none", size: "md", class: { root: "rounded-lg" } },
		{ groupPosition: "none", size: "lg", class: { root: "rounded-lg" } },
		// Joined, it takes the *group's* corner instead. A group owns the shape
		// of its run, so a field capping one end of it has to draw the same arc
		// the button capping the other end does — two ramps meeting in one row
		// is the mismatch this replaces. These strings must match the button's
		// cell for cell.
		{ groupPosition: "only", size: "sm", class: { root: "rounded-button-sm" } },
		{ groupPosition: "only", size: "md", class: { root: "rounded-button-md" } },
		{ groupPosition: "only", size: "lg", class: { root: "rounded-button-lg" } },
		{
			groupPosition: "first",
			orientation: "horizontal",
			size: "sm",
			class: { root: "rounded-s-button-sm rounded-e-none" },
		},
		{
			groupPosition: "first",
			orientation: "horizontal",
			size: "md",
			class: { root: "rounded-s-button-md rounded-e-none" },
		},
		{
			groupPosition: "first",
			orientation: "horizontal",
			size: "lg",
			class: { root: "rounded-s-button-lg rounded-e-none" },
		},
		{
			groupPosition: "last",
			orientation: "horizontal",
			size: "sm",
			class: { root: "rounded-e-button-sm rounded-s-none" },
		},
		{
			groupPosition: "last",
			orientation: "horizontal",
			size: "md",
			class: { root: "rounded-e-button-md rounded-s-none" },
		},
		{
			groupPosition: "last",
			orientation: "horizontal",
			size: "lg",
			class: { root: "rounded-e-button-lg rounded-s-none" },
		},
		{
			groupPosition: "first",
			orientation: "vertical",
			size: "sm",
			class: { root: "rounded-t-button-sm rounded-b-none" },
		},
		{
			groupPosition: "first",
			orientation: "vertical",
			size: "md",
			class: { root: "rounded-t-button-md rounded-b-none" },
		},
		{
			groupPosition: "first",
			orientation: "vertical",
			size: "lg",
			class: { root: "rounded-t-button-lg rounded-b-none" },
		},
		{
			groupPosition: "last",
			orientation: "vertical",
			size: "sm",
			class: { root: "rounded-b-button-sm rounded-t-none" },
		},
		{
			groupPosition: "last",
			orientation: "vertical",
			size: "md",
			class: { root: "rounded-b-button-md rounded-t-none" },
		},
		{
			groupPosition: "last",
			orientation: "vertical",
			size: "lg",
			class: { root: "rounded-b-button-lg rounded-t-none" },
		},
		{ isSeamed: true, orientation: "horizontal", class: { root: "-ms-px" } },
		{ isSeamed: true, orientation: "vertical", class: { root: "-mt-px" } },
	],
	defaultVariants: {
		variant: "primary",
		size: "md",
		isFocused: false,
		isInvalid: false,
		isDisabled: false,
		isMultiline: false,
		isGrouped: false,
		placement: "row",
		blockPosition: "none",
		orientation: "horizontal",
		groupPosition: "none",
		isSeamed: false,
	},
});

/** The axes that decide how a field's box is drawn, wherever that box lands. */
export type InputBoxState = {
	variant?: InputVariant;
	size?: InputSize;
	isDisabled?: boolean;
	isFocused?: boolean;
	isInvalid?: boolean;
	isMultiline?: boolean;
	/** Where the field sits in an enclosing `Button.Group`, if it is in one. */
	groupPosition?: ButtonGroupSlotPosition;
	/** Which way that group runs. Read only when `groupPosition` is not `none`. */
	orientation?: ButtonGroupOrientation;
	/** Overlap the member before it, so the shared edge is drawn once. */
	isSeamed?: boolean;
};

/**
 * The class the `TextInput` itself wears.
 *
 * Standalone, the field *is* the box, so it takes the chrome and the text
 * treatment together. Inside an `Input.Group` the box belongs to the row and
 * the field takes the text treatment alone — otherwise the two would draw two
 * borders, one inside the other.
 *
 * This is the single decision that keeps a grouped field indistinguishable from
 * a lone one: both read the same `root` slot, so there is no second class
 * string that could drift from the first.
 *
 * Pure, so the whole matrix is unit-testable. See AGENTS.md.
 */
export function resolveInputFieldClass({
	className,
	isGrouped = false,
	...state
}: InputBoxState & { className?: string; isGrouped?: boolean }): string {
	const slots = inputVariants({ ...state, isGrouped });
	return isGrouped ? slots.field({ className }) : cn(slots.root(), slots.field({ className }));
}

/** The box state of a group, which also knows whether it holds a block. */
export type InputGroupBoxState = InputBoxState & {
	/** A block above or below the row, which frees the box to grow past one line. */
	hasBlocks?: boolean;
	className?: string;
};

/**
 * The class `Input.Group`'s outer element wears: the same box a lone field
 * would draw, and nothing else. The row inside it is {@link resolveInputGroupRowClass}.
 *
 * A block makes the box taller than one line, so with one present the box takes
 * the multiline branch of the height — a floor plus vertical padding — whatever
 * the field is. The row keeps its own alignment, so a single-line field stays
 * centred in it.
 *
 * Pure, so the whole matrix is unit-testable. See AGENTS.md.
 */
export function resolveInputGroupClass({
	className,
	hasBlocks = false,
	isMultiline = false,
	...state
}: InputGroupBoxState): string {
	return inputVariants({ ...state, isGrouped: true, isMultiline: isMultiline || hasBlocks }).root({ className });
}

/**
 * The class `Input.Group`'s inner row wears — layout only, never chrome. The
 * row is always rendered, blocks or not, so adding one never remounts the field.
 *
 * Pure, so it is unit-testable. See AGENTS.md.
 */
export function resolveInputGroupRowClass({ className, hasBlocks: _hasBlocks, ...state }: InputGroupBoxState): string {
	return inputVariants({ ...state, isGrouped: true }).row({ className });
}

/** What a decorator's child is, as far as deciding whether it is decorative goes. */
export type InputDecoratorChildKind = "text" | "icon" | "other";

/**
 * Whether a decorator is purely visual — hidden from screen readers and
 * transparent to touches.
 *
 * An explicit value wins. Otherwise a decorator holding only bare text and
 * `Icon`s is decorative — a currency sign, a unit, a magnifying glass — and one
 * holding anything else might be a control, so it stays reachable. An empty
 * decorator has nothing to hide.
 *
 * Pure, so it is unit-testable. See AGENTS.md.
 */
export function resolveIsDecorative({
	explicit,
	kinds,
}: {
	explicit?: boolean;
	kinds: readonly InputDecoratorChildKind[];
}): boolean {
	if (explicit !== undefined) return explicit;
	return kinds.length > 0 && kinds.every((kind) => kind !== "other");
}

/**
 * The size of a `Button` inside a group: one step below the box, so it sits
 * inside the border with room around it, and square when it holds only an icon.
 * `sm` has no smaller step, so it stays `sm`.
 *
 * Pure, so it is unit-testable. See AGENTS.md.
 */
export function resolveGroupButtonSize(size: InputSize, isIconOnly: boolean): ButtonSize {
	const step = GROUP_BUTTON_STEP[size];
	return isIconOnly ? `icon-${step}` : step;
}

const GROUP_BUTTON_STEP: Record<InputSize, InputSize> = { sm: "sm", md: "sm", lg: "md" };

/**
 * The extra class a `Button` inside a group takes.
 *
 * A disabled group fades its whole box once. The button inside it is disabled
 * too, so it is inert — but its own `opacity-50` would fade it a second time, to
 * a quarter. `opacity-100` replaces that one utility through the button's own
 * className merge, and leaves the rest of its disabled treatment alone.
 *
 * Pure, so it is unit-testable. See AGENTS.md.
 */
export function resolveGroupButtonClass({
	isDisabled,
	className,
}: {
	isDisabled: boolean;
	className?: string;
}): string {
	return cn(isDisabled && "opacity-100", className);
}

/** What a direct child of a group is, as far as placing it goes. */
export type InputGroupChildKind = "block-start" | "block-end" | "separator" | "content";

/** Where a direct child of a group renders: above the row, in it, or below it. */
export type InputGroupSegment = "start" | "row" | "end";

/**
 * Sorts a group's direct children into the box's three sections.
 *
 * A block goes where its `position` says, wherever it was written. Everything
 * else is row content, except a separator written outside the content — before
 * the first piece of it or after the last — which divides a block from the row
 * and so belongs to the box. A separator between two pieces of content stays in
 * the row as a vertical hairline.
 *
 * Done by sorting rather than by a block registering itself after mount: the
 * sections are known in the first render, so the box never draws one frame as a
 * row and the next as a column.
 *
 * Pure, so it is unit-testable. See AGENTS.md.
 */
export function resolveGroupSegments(kinds: readonly InputGroupChildKind[]): InputGroupSegment[] {
	const first = kinds.indexOf("content");
	const last = kinds.lastIndexOf("content");

	return kinds.map((kind, index) => {
		if (kind === "block-start") return "start";
		if (kind === "block-end") return "end";
		if (kind === "content") return "row";
		if (first === -1) return "start";
		if (index < first) return "start";
		if (index > last) return "end";
		return "row";
	});
}

/**
 * Which of a group's direct children are the outermost blocks: the first
 * `start` block and the last `end` block.
 *
 * Only these sit against the box's border, so only these take the negative
 * margin that cancels the box's own padding. A second start block sits under a
 * separator or another block, and pulling it up would draw it over that.
 *
 * Pure, so it is unit-testable. See AGENTS.md.
 */
export function resolveOuterBlocks(kinds: readonly InputGroupChildKind[]): boolean[] {
	const firstStart = kinds.indexOf("block-start");
	const lastEnd = kinds.lastIndexOf("block-end");
	return kinds.map((_, index) => index === firstStart || index === lastEnd);
}

/**
 * The `accent-*` class uniwind resolves the placeholder colour from.
 *
 * Pure, so it is unit-testable. See AGENTS.md.
 */
export function resolvePlaceholderAccentClass(className?: string): string {
	return cn(INPUT_PLACEHOLDER_ACCENT_CLASS, className);
}

/**
 * The `accent-*` class uniwind resolves the caret and selection colour from.
 *
 * An invalid field tints them destructive along with its border, so the state is
 * still legible while the value is being corrected — the moment the border is
 * the only thing carrying it. A caller's class still wins.
 *
 * Pure, so it is unit-testable. See AGENTS.md.
 */
export function resolveSelectionAccentClass({
	className,
	isInvalid = false,
}: {
	className?: string;
	isInvalid?: boolean;
}): string {
	return cn(isInvalid ? INPUT_INVALID_SELECTION_ACCENT_CLASS : INPUT_SELECTION_ACCENT_CLASS, className);
}

/**
 * The accessible name a screen reader announces when the field takes focus.
 *
 * The caller's `accessibilityLabel` wins; otherwise the text an enclosing
 * `Field.Label` registered with the field's context, so
 * `<Field><Field.Label>Email</Field.Label><Input /></Field>` reads "Email"
 * rather than an unnamed text field. React Native has no `<label for>`; this is
 * that association, the same way `OtpInput` makes it. With neither there is no
 * name, and `undefined` leaves the native default rather than an empty string.
 *
 * Pure, so it is unit-testable. See AGENTS.md.
 */
export function resolveInputAccessibilityLabel(
	own: string | undefined,
	fieldLabel: string | null | undefined
): string | undefined {
	return own ?? fieldLabel ?? undefined;
}

export type InputVariantProps = VariantProps<typeof inputVariants>;
