import type { VariantProps } from "tailwind-variants";
import { tv } from "@/lib/tv";
import type { TextColor } from "@/components/ui/text/text.variants";

export const FIELD_ORIENTATIONS = ["vertical", "horizontal"] as const;

export const FIELD_LEGEND_VARIANTS = ["legend", "label"] as const;

/** The parts that render a `Text` and therefore need a colour rather than a class. */
export const FIELD_TEXT_PARTS = ["label", "description", "error"] as const;

export type FieldOrientation = (typeof FIELD_ORIENTATIONS)[number];
export type FieldLegendVariant = (typeof FIELD_LEGEND_VARIANTS)[number];
export type FieldTextPart = (typeof FIELD_TEXT_PARTS)[number];

/**
 * Layout for a form field and the structures that hold one.
 *
 * One slotted `tv()` rather than a call per part, so the spacing ladder is
 * declared in a single place. That ladder is the component: `content` groups a
 * label with its description, `root` groups a field's parts, `set` groups a
 * legend with its fields, and `group` separates one field from the next. Each
 * step is looser than the one inside it, which is what makes a field read as one
 * thing and two fields as two — `field.variants.test.ts` pins the ordering
 * rather than the numbers, so the spacing can be retuned without the test
 * becoming a transcript of it.
 *
 * **No slot here carries a type scale or a colour.** The text parts render the
 * `Text` presets — `Text.Label`, `Text.Caption` — and pass a colour through
 * {@link resolveFieldTextColor}, so the scale lives in exactly one place. A
 * `text-sm font-medium` written here would be a second definition of
 * `Text.Label` that could drift from it, which is the reason `Input` ships no
 * label part of its own. The slots hold state and layout only.
 *
 * The `View` slots hold no `text-*` at all: a React Native `View` does not
 * cascade colour to a `Text` descendant. See AGENTS.md rule 1.
 *
 * Free of React Native imports so it stays unit-testable — `bun test` cannot
 * parse React Native's Flow-typed source. See AGENTS.md.
 */
export const fieldVariants = tv({
	slots: {
		root: "w-full gap-1.5",
		/** A legend, its description and the fields under them. */
		set: "w-full gap-4",
		/** Field to field — the loosest step, so two fields never read as one. */
		group: "w-full gap-5",
		/** A label and its description, as one block beside a control. */
		content: "min-w-0 flex-1 gap-0.5",
		label: "",
		description: "",
		error: "",
		legend: "",
		/** The row a separator's rules and its optional label share. */
		separator: "w-full flex-row items-center gap-3",
		/** Each rule takes the width the label does not. */
		separatorLine: "flex-1",
	},
	variants: {
		orientation: {
			vertical: { root: "flex-col" },
			// `justify-between` is what pushes the control to the far edge, and it
			// is the root's job rather than the label's. The web kit grows the label
			// instead — `*:data-[slot=field-label]:flex-auto` — which needs a child
			// selector uniwind does not have, and would stretch the label vertically
			// once it sat inside a `Field.Content` column rather than beside it.
			horizontal: { root: "flex-row items-center justify-between" },
		},
		variant: {
			legend: { legend: "font-medium" },
			label: { legend: "" },
		},
		// The empty `false` branches are load-bearing typing, not placeholders.
		// `tv` derives the prop type from the declared keys, so a map with only
		// `true` types the prop as `true` rather than `boolean`. See the note in
		// button.variants.ts.
		isInvalid: { true: {}, false: {} },
		// Only the label fades. The control dims itself, and a description
		// dimmed on top of an already dimmed control reads as two problems
		// rather than one state.
		isDisabled: { true: { label: "opacity-50" }, false: {} },
	},
	defaultVariants: {
		orientation: "vertical",
		variant: "legend",
		isInvalid: false,
		isDisabled: false,
	},
});

/**
 * The `Text` colour a text part takes, given the field's state.
 *
 * Returning `undefined` is meaningful rather than lazy: `Text`'s `color` axis
 * emits nothing when it is not named, so the part falls through to its preset's
 * own colour — `text-foreground` for a label, `text-muted-foreground` for a
 * description. That is what lets a part say "leave it alone" without knowing
 * which token its preset chose.
 *
 * The label turns with the control it names, so the pair reads as one state. The
 * description stays muted in both, so the error is the one line that appeared.
 * The error is destructive even outside an invalid field, because an error message is
 * never the calm case.
 *
 * Pure, so the whole matrix is reachable from `bun test`. See AGENTS.md.
 */
export function resolveFieldTextColor(part: FieldTextPart, isInvalid: boolean): TextColor | undefined {
	switch (part) {
		case "label":
			return isInvalid ? "destructive" : undefined;
		case "error":
			return "destructive";
		default:
			return undefined;
	}
}

/**
 * Whether the field's row should render as a `Pressable` rather than a `View`.
 *
 * Only once a control inside has offered a press. A field is layout until then,
 * and mounting a `GestureDetector` regardless would put one under every label
 * and description in a form — the same thing `Badge` refuses to do for a list of
 * fifty tags, and for the same reason: assistive technology would announce a row
 * of static text as something you can activate.
 *
 * A type predicate rather than a plain boolean, so the branch that renders the
 * `Pressable` gets a non-null `onPress` out of the same check that decided it.
 *
 * Pure, so the decision is reachable from `bun test`. See AGENTS.md.
 */
export function resolveFieldInteractive(press: (() => void) | null): press is () => void {
	return press !== null;
}

/**
 * The text a `Field.Label` can lend to the control beside it as its accessible
 * name, or `null` when it has none to lend.
 *
 * Only a bare string or number qualifies. A label built from elements has no
 * text this side of a render, and guessing at one would name a control after
 * the wrong thing — an icon's key, say. Whitespace is trimmed and an empty
 * string is an absence, because a screen reader handed `""` reads nothing at
 * all, which is worse than reading the value alone.
 *
 * React Native has no `<label for>`; this is the association, done by hand
 * through the field's context. Pure, so `bun test` reaches it. See AGENTS.md.
 */
export function resolveFieldLabelText(children: unknown): string | null {
	if (typeof children === "number") return String(children);
	if (typeof children !== "string") return null;
	const text = children.trim();
	return text === "" ? null : text;
}

export type FieldVariantProps = VariantProps<typeof fieldVariants>;
