import type { VariantProps } from "tailwind-variants";
import { cn } from "@/lib/cn";
import { tv } from "@/lib/tv";
import type { ButtonGroupOrientation, ButtonGroupSlotPosition } from "@/components/ui/button/button.variants";

export const INPUT_VARIANTS = ["primary", "secondary"] as const;

export const INPUT_SIZES = ["sm", "md", "lg"] as const;

export type InputVariant = (typeof INPUT_VARIANTS)[number];
export type InputSize = (typeof INPUT_SIZES)[number];

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
 * than by two class strings happening to agree; `input.variants.test.ts` pins
 * it as a property over every combination of the axes.
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
 * Free of React Native imports so it stays unit-testable — `bun test` cannot
 * parse React Native's Flow-typed source. See AGENTS.md.
 */
export const inputVariants = tv({
	slots: {
		root: "overflow-hidden border",
		/** Layout for the group's row. Never applied to a lone field, which is not a row. */
		row: "flex-row items-center",
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
		},
		size: {
			sm: {
				root: "px-2.5",
				row: "gap-1.5",
				field: "text-input-sm leading-tight",
				decoratorIcon: "size-icon-sm",
				decoratorText: "text-input-sm",
			},
			md: {
				root: "px-3",
				row: "gap-2",
				field: "text-input-md leading-tight",
				decoratorIcon: "size-icon-md",
				decoratorText: "text-input-md",
			},
			lg: {
				root: "px-3.5",
				row: "gap-2.5",
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
		// The corner a lone field draws: the generic ramp, deliberately not the
		// button's, because a field and the button beside it are meant to be
		// retunable apart. `sm` steps down a notch; the other two share `lg`.
		{ groupPosition: "none", size: "sm", class: { root: "rounded-md" } },
		{ groupPosition: "none", size: "md", class: { root: "rounded-lg" } },
		{ groupPosition: "none", size: "lg", class: { root: "rounded-lg" } },
		// Joined, it takes the *group's* corner instead. A group owns the shape
		// of its run, so a field capping one end of it has to draw the same arc
		// the button capping the other end does — two ramps meeting in one row
		// is the mismatch this replaces. `button.variants.test.ts` asserts these
		// strings match the button's cell for cell.
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
 * Pure, so the whole matrix is reachable from `bun test`. See AGENTS.md.
 */
export function resolveInputFieldClass({
	className,
	isGrouped = false,
	...state
}: InputBoxState & { className?: string; isGrouped?: boolean }): string {
	const slots = inputVariants({ ...state, isGrouped });
	return isGrouped ? slots.field({ className }) : cn(slots.root(), slots.field({ className }));
}

/**
 * The class `Input.Group`'s row wears: the same box a lone field would draw,
 * laid out as a row so the decorators and the field can share it.
 *
 * Pure, so the whole matrix is reachable from `bun test`. See AGENTS.md.
 */
export function resolveInputGroupClass({ className, ...state }: InputBoxState & { className?: string }): string {
	const slots = inputVariants({ ...state, isGrouped: true });
	return cn(slots.root(), slots.row({ className }));
}

/**
 * The `accent-*` class uniwind resolves the placeholder colour from.
 *
 * Pure, so it is reachable from `bun test`. See AGENTS.md.
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
 * Pure, so it is reachable from `bun test`. See AGENTS.md.
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

export type InputVariantProps = VariantProps<typeof inputVariants>;
