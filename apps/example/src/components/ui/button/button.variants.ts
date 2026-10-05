import type { VariantProps } from "tailwind-variants";
import { tv } from "@/lib/tv";
import type { PressableFeedback } from "@/components/ui/pressable/pressable.variants";

export const BUTTON_VARIANTS = [
	"primary",
	"secondary",
	"tertiary",
	"outline",
	"ghost",
	"destructive",
	"destructive-soft",
] as const;

/** Sizes that hold a label. Horizontal padding; the width comes from the content. */
export const BUTTON_LABEL_SIZES = ["sm", "md", "lg"] as const;

/** Sizes with a square footprint, for a button whose only content is an icon. */
export const BUTTON_ICON_SIZES = ["icon-sm", "icon-md", "icon-lg"] as const;

/**
 * Every value `size` accepts.
 *
 * Derived rather than written out — a tuple key is not a class, so composing one
 * costs nothing. The class strings below are a different matter and are spelled
 * in full; see the note on the `size` axis.
 */
export const BUTTON_SIZES = [...BUTTON_LABEL_SIZES, ...BUTTON_ICON_SIZES] as const;

export const BUTTON_SPINNER_PLACEMENTS = ["start", "end", "only"] as const;

export const BUTTON_GROUP_ORIENTATIONS = ["horizontal", "vertical"] as const;

export const BUTTON_GROUP_POSITIONS = ["first", "middle", "last", "only"] as const;

export type ButtonVariant = (typeof BUTTON_VARIANTS)[number];
export type ButtonLabelSize = (typeof BUTTON_LABEL_SIZES)[number];
export type ButtonIconSize = (typeof BUTTON_ICON_SIZES)[number];
export type ButtonSize = (typeof BUTTON_SIZES)[number];
export type ButtonSpinnerPlacement = (typeof BUTTON_SPINNER_PLACEMENTS)[number];
export type ButtonGroupOrientation = (typeof BUTTON_GROUP_ORIENTATIONS)[number];
export type ButtonGroupPosition = (typeof BUTTON_GROUP_POSITIONS)[number];

/** A member's place in its group, or `none` for a button standing on its own. */
export type ButtonGroupSlotPosition = ButtonGroupPosition | "none";

/**
 * The axis a group's separator runs along — a rule crosses the run.
 *
 * Typed on the group's own union rather than on `SeparatorOrientation`, which
 * lives in `separator.tsx` beside a React Native import and would make this file
 * unparseable by `bun test`. The two vocabularies are the same two words, and a
 * test asserts this map still names one of them.
 */
export const BUTTON_GROUP_SEPARATOR_ORIENTATION: Record<ButtonGroupOrientation, ButtonGroupOrientation> = {
	horizontal: "vertical",
	vertical: "horizontal",
};

/** What a button presses with on its own, and what it presses with joined. */
export const BUTTON_FEEDBACK: PressableFeedback = "scale";
export const BUTTON_GROUP_FEEDBACK: PressableFeedback = "fade";

/** Theme token whose value gives icons and text their colour on each surface. */
export const BUTTON_FOREGROUND_TOKEN: Record<ButtonVariant, string> = {
	primary: "primary-foreground",
	secondary: "secondary-foreground",
	tertiary: "tertiary-foreground",
	outline: "foreground",
	ghost: "foreground",
	destructive: "destructive-foreground",
	"destructive-soft": "destructive-soft-foreground",
};

/**
 * Styling for every part of a button.
 *
 * One slotted `tv()` rather than a call per part, so `size` and `variant` are
 * declared once.
 *
 * A size names tokens rather than raw utilities: `h-button-md` for the height,
 * `text-button-md` for the label, `rounded-button-md` for the corner,
 * `size-icon-md` for a composed glyph. The values live in `tokens.css`, so a
 * button's icon and the spinner that replaces it resolve to the same edge
 * length by construction rather than by two numbers happening to agree. `cn`
 * has to know these token names — see `lib/cn.ts`. The root holds no `text-*`
 * utility: a React Native `View` does not cascade colour to a `Text`
 * descendant, so label colour lives on the `label` slot and icon colour is
 * resolved from {@link BUTTON_FOREGROUND_TOKEN}.
 *
 * The corner belongs to the size axis and the group axis together, and to
 * nothing else — not the base, not a variant — so exactly one corner
 * *statement* ever reaches the root and a caller's `rounded-lg` has a single
 * thing to beat. Each step is half its own height, which draws a capsule, and a
 * circle on the square steps.
 *
 * A joined member **replaces** that corner with a per-side pair rather than
 * layering a squaring class on top of it. Layering would in fact render
 * correctly — Uniwind arbitrates a className string per style property in token
 * order, and React Native puts a per-corner radius above the uniform one — but
 * tailwind-merge deletes a side class the moment any all-corner class is emitted
 * after it, and the `size` branch emitting one is exactly that case. Correctness
 * would then rest on the key order of this object, one reorder away from a
 * silent regression.
 *
 * A horizontal member squares on the inline axis (`rounded-s-*` / `rounded-e-*`,
 * which flip under RTL); a vertical one squares top and bottom, where there is
 * no logical form and no flip to want. **Never mix the two on one member** —
 * React Native resolves a physical corner above a logical one, so a stray
 * `rounded-t-*` would silently outrank a `rounded-s-*` beside it.
 *
 * A seamed member overlaps the one before it by a point, so two adjacent borders
 * draw as one hairline instead of two. That is a negative margin rather than a
 * dropped border on purpose: a margin moves the box and changes nothing about
 * it, while `border-s-0` would make the member a point narrower than its
 * neighbours and shift its centred content half a point — and would only be
 * right for the variants that draw a visible border, which the group cannot know
 * because a member may name its own.
 *
 * `overflow-hidden` on the root is load-bearing rather than tidiness — a pressed
 * button fades to the edge of its own box, and the fade is clipped to the same
 * corner the button draws.
 *
 * Free of React Native imports so it stays unit-testable — `bun test` cannot
 * parse React Native's Flow-typed source. See AGENTS.md.
 */
export const buttonVariants = tv({
	slots: {
		root: "flex-row items-center justify-center gap-2 overflow-hidden border border-transparent",
		label: "text-center font-semibold",
		startContent: "items-center justify-center",
		endContent: "items-center justify-center",
		/** Edge length an `Icon` or `Spinner` composed into the button inherits. */
		icon: "",
		/**
		 * A `Button.Group`'s box.
		 *
		 * Holds no `gap` and no `overflow-hidden`, and both absences are
		 * load-bearing. A gap is the seam this component exists to close. A clip
		 * would square off the very corners the position compounds just rounded,
		 * and would have to restate the group's own corner to avoid it — while the
		 * members already square themselves, which is the whole point.
		 *
		 * Paints no state of its own either: a disabled group publishes
		 * `isDisabled` and each member fades itself, so a group and its members
		 * cannot compound `opacity-50` down to a quarter.
		 */
		group: "",
		/** Wraps a group's rule. `shrink-0`, or a row of `flex-1` members squeezes it to nothing. */
		groupSeparator: "shrink-0",
	},
	variants: {
		variant: {
			primary: { root: "bg-primary", label: "text-primary-foreground" },
			secondary: { root: "bg-secondary", label: "text-secondary-foreground" },
			tertiary: { root: "bg-tertiary", label: "text-tertiary-foreground" },
			outline: { root: "border-border bg-transparent", label: "text-foreground" },
			ghost: { root: "border-transparent bg-transparent", label: "text-foreground" },
			destructive: { root: "bg-destructive", label: "text-destructive-foreground" },
			"destructive-soft": { root: "bg-destructive-soft", label: "text-destructive-soft-foreground" },
		},
		// Six steps in two families, and a square is a step rather than a flag on
		// one. `icon-md` is `md` with its horizontal padding traded for a width
		// off the same token, so the two can never fight each other in the merge
		// the way a boolean crossed with a size had to.
		//
		// Written out rather than built. Tailwind scans source text, so a class
		// assembled at runtime — `h-button-${step}` — is never compiled and
		// silently draws nothing; see `styles/tokens.ts`. The tuples above are
		// keys, not classes, which is why those may be composed and these may not.
		//
		// A square carries no `gap`: it holds one child. That is also what keeps
		// each row on one line, which is the whole readability of the table.
		//
		// The square steps are reachable only through `size`, never through
		// loading. A definite width defeats the parent's `alignItems: stretch` —
		// a stretch-aligned child with a definite cross size resolves to
		// cross-*start* — so a full-width button that squared itself the moment
		// work began would snap to a small box flush against the left edge. That
		// is why `spinnerPlacement="only"` swaps the content and leaves the
		// footprint exactly as the caller sized it.
		size: {
			sm: { root: "h-button-sm gap-1.5 px-3", label: "text-button-sm", icon: "size-icon-sm" },
			md: { root: "h-button-md px-4", label: "text-button-md", icon: "size-icon-md" },
			lg: { root: "h-button-lg px-5", label: "text-button-lg", icon: "size-icon-lg" },
			"icon-sm": { root: "h-button-sm w-button-sm", label: "text-button-sm", icon: "size-icon-sm" },
			"icon-md": { root: "h-button-md w-button-md", label: "text-button-md", icon: "size-icon-md" },
			"icon-lg": { root: "h-button-lg w-button-lg", label: "text-button-lg", icon: "size-icon-lg" },
		},
		/** Which way a `Button.Group` runs. Only the `group` slot reads it on its own. */
		orientation: {
			horizontal: { group: "flex-row self-start" },
			vertical: { group: "flex-col" },
		},
		// `middle` is the one position whose corner needs neither the size nor the
		// orientation, so it lands here rather than in six compound cells that
		// would all say the same word.
		groupPosition: { none: {}, first: {}, middle: { root: "rounded-none" }, last: {}, only: {} },
		// The empty `false` branches are load-bearing typing, not placeholders.
		// `tv` derives the prop type from the declared keys, so a map with only
		// `true` types the prop as `true` rather than `boolean` and rejects
		// `buttonVariants({ isLoading })`. The compound variants below would match
		// without them — `tv` compares against `defaultVariants` plus props and
		// never reads this map.
		isSeamed: { true: {}, false: {} },
		isDisabled: { true: { root: "opacity-50" }, false: {} },
		isLoading: { true: {}, false: {} },
		isDimmedWhileLoading: { true: {}, false: {} },
	},
	compoundVariants: [
		// Loading is not a disabled state. The button keeps full contrast — the
		// spinner already says the press landed — unless the caller opts in.
		{ isLoading: true, isDimmedWhileLoading: true, class: { root: "opacity-50" } },
		// A lone button and a lone member draw the same corner, so the two positions
		// share a cell. Each step pairs its label size with its square one: a corner
		// is half the button's height, and an `icon-*` step is the same height as the
		// label step it is named for.
		{ groupPosition: ["none", "only"], size: ["sm", "icon-sm"], class: { root: "rounded-button-sm" } },
		{ groupPosition: ["none", "only"], size: ["md", "icon-md"], class: { root: "rounded-button-md" } },
		{ groupPosition: ["none", "only"], size: ["lg", "icon-lg"], class: { root: "rounded-button-lg" } },
		// Each cell names all four corners, so none is left to a default and a
		// uniform radius could not leak into one.
		{
			groupPosition: "first",
			orientation: "horizontal",
			size: ["sm", "icon-sm"],
			class: { root: "rounded-s-button-sm rounded-e-none" },
		},
		{
			groupPosition: "first",
			orientation: "horizontal",
			size: ["md", "icon-md"],
			class: { root: "rounded-s-button-md rounded-e-none" },
		},
		{
			groupPosition: "first",
			orientation: "horizontal",
			size: ["lg", "icon-lg"],
			class: { root: "rounded-s-button-lg rounded-e-none" },
		},
		{
			groupPosition: "last",
			orientation: "horizontal",
			size: ["sm", "icon-sm"],
			class: { root: "rounded-e-button-sm rounded-s-none" },
		},
		{
			groupPosition: "last",
			orientation: "horizontal",
			size: ["md", "icon-md"],
			class: { root: "rounded-e-button-md rounded-s-none" },
		},
		{
			groupPosition: "last",
			orientation: "horizontal",
			size: ["lg", "icon-lg"],
			class: { root: "rounded-e-button-lg rounded-s-none" },
		},
		{
			groupPosition: "first",
			orientation: "vertical",
			size: ["sm", "icon-sm"],
			class: { root: "rounded-t-button-sm rounded-b-none" },
		},
		{
			groupPosition: "first",
			orientation: "vertical",
			size: ["md", "icon-md"],
			class: { root: "rounded-t-button-md rounded-b-none" },
		},
		{
			groupPosition: "first",
			orientation: "vertical",
			size: ["lg", "icon-lg"],
			class: { root: "rounded-t-button-lg rounded-b-none" },
		},
		{
			groupPosition: "last",
			orientation: "vertical",
			size: ["sm", "icon-sm"],
			class: { root: "rounded-b-button-sm rounded-t-none" },
		},
		{
			groupPosition: "last",
			orientation: "vertical",
			size: ["md", "icon-md"],
			class: { root: "rounded-b-button-md rounded-t-none" },
		},
		{
			groupPosition: "last",
			orientation: "vertical",
			size: ["lg", "icon-lg"],
			class: { root: "rounded-b-button-lg rounded-t-none" },
		},
		// Written out per orientation rather than built from the axis, because
		// Tailwind's scanner is static: a class assembled at runtime is never
		// compiled and Uniwind's store has nothing to look up. See AGENTS.md.
		{ isSeamed: true, orientation: "horizontal", class: { root: "-ms-px" } },
		{ isSeamed: true, orientation: "vertical", class: { root: "-mt-px" } },
	],
	defaultVariants: {
		variant: "primary",
		size: "md",
		orientation: "horizontal",
		groupPosition: "none",
		isSeamed: false,
		isDisabled: false,
		isLoading: false,
		isDimmedWhileLoading: false,
	},
});

/** What the spinner does to a button's children, once loading and placement are folded together. */
export type ButtonLayout = {
	/** The spinner has replaced the children entirely. */
	isSpinnerOnly: boolean;
	/** Side the spinner is composed onto, or null when no spinner is shown. */
	spinnerSide: "start" | "end" | null;
};

/**
 * Folds `isLoading` and `spinnerPlacement` into the facts the content needs.
 *
 * It says nothing about the footprint, and that is the point: `only` swaps the
 * content out and leaves the button exactly the size the caller asked for. A
 * square is a `size`, so `only` cannot reach it — see the note on the `size`
 * axis for the `alignItems: stretch` failure that rules out earning one here.
 *
 * Pure, so the whole matrix is reachable from `bun test`. See AGENTS.md.
 */
export function resolveButtonLayout({
	isLoading = false,
	spinnerPlacement = "start",
}: {
	isLoading?: boolean;
	spinnerPlacement?: ButtonSpinnerPlacement;
}): ButtonLayout {
	if (!isLoading) return { isSpinnerOnly: false, spinnerSide: null };
	if (spinnerPlacement === "only") return { isSpinnerOnly: true, spinnerSide: null };
	return { isSpinnerOnly: false, spinnerSide: spinnerPlacement };
}

/**
 * Index of the child the spinner should replace, or null to insert one.
 *
 * A loading button swaps its icon for the spinner rather than showing both.
 * Adding one would push the label sideways the moment work started and pull it
 * back when it finished — and with the spinner and the icon drawn at the same
 * `size-icon-*` token, replacing costs no layout at all.
 *
 * Only the child at the named edge is a candidate — the first at `start`, the
 * last at `end`. An icon on the other side is left alone and the spinner is
 * inserted at the edge instead: `spinnerPlacement` says where the caller wants
 * the spinner, so taking the one icon a button holds regardless of which side
 * it sits on would draw the spinner opposite the side that was asked for.
 *
 * Pure, so the whole matrix is reachable from `bun test`. See AGENTS.md.
 */
export function resolveSpinnerSwapIndex(isIcon: readonly boolean[], side: "start" | "end"): number | null {
	const index = side === "start" ? 0 : isIcon.length - 1;
	return isIcon[index] === true ? index : null;
}

/**
 * The labelled step a size is built on — `icon-md` is `md`'s height.
 *
 * A square size is its labelled step with the horizontal padding traded for a
 * width off the same token, so the two share a height and therefore a corner.
 * Anything that needs the step rather than the shape reads it through here
 * rather than slicing the prefix at the call site: a control joining a
 * `Button.Group` has to line up with the run without having a square form of its
 * own, which is exactly what an `Input` does.
 *
 * Pure, so the whole matrix is reachable from `bun test`. See AGENTS.md.
 */
export function resolveButtonSizeStep(size: ButtonSize): ButtonLabelSize {
	return (size.startsWith("icon-") ? size.slice("icon-".length) : size) as ButtonLabelSize;
}

/**
 * The size a member draws at, once its group has had its say.
 *
 * A group owns the *step* outright — members of different heights do not join —
 * but not the *shape*. Those are one axis since a square footprint became a size
 * rather than a flag, so resolving the whole prop to the group's value would
 * make a square member impossible inside a run: the icon button at the end of a
 * split button would silently grow a label's padding and lose its width.
 *
 * So the step comes from the group and the shape from the member, falling back
 * to the group's own shape when the member names no size. `icon-md` inside a
 * `sm` group is `icon-sm` — square, and the same height as everything beside it.
 *
 * Pure, so the whole matrix is reachable from `bun test`. See AGENTS.md.
 */
export function resolveGroupedButtonSize(own: ButtonSize | undefined, group: ButtonSize | undefined): ButtonSize {
	if (group === undefined) return own ?? "md";
	const step = resolveButtonSizeStep(group);
	const isSquare = own === undefined ? group.startsWith("icon-") : own.startsWith("icon-");
	return (isSquare ? `icon-${step}` : step) as ButtonSize;
}

/**
 * Where each child sits among the group's *members*.
 *
 * `null` is "not a member". A `Button.Group.Separator` between two buttons is a
 * rule, not a segment, so the buttons either side of one are still the first and
 * the last and keep their rounded outer corners. A single member is `only` and
 * draws the corner it would have alone, which is what makes a group rendering
 * one button conditionally look no different from the button on its own.
 *
 * Takes an array of "is this child a member" rather than the children
 * themselves, so it stays free of React and reachable from `bun test` — the
 * trade {@link resolveSpinnerSwapIndex} already makes. React Native has no
 * sibling selector, so this is the only place a member's corner can be decided.
 *
 * Pure, so the whole matrix is reachable from `bun test`. See AGENTS.md.
 */
export function resolveGroupPositions(isMember: readonly boolean[]): (ButtonGroupPosition | null)[] {
	const count = isMember.reduce((total, member) => (member ? total + 1 : total), 0);
	let seen = 0;

	return isMember.map((member) => {
		if (!member) return null;
		const index = seen++;
		if (count === 1) return "only";
		if (index === 0) return "first";
		if (index === count - 1) return "last";
		return "middle";
	});
}

/**
 * Which members overlap the one before them, so a shared border draws once.
 *
 * Only where two members are *adjacent*. A member following a
 * `Button.Group.Separator` must not overlap: the rule is one point wide, and a
 * one-point overlap would slide straight over it and delete the divider the
 * caller asked for.
 *
 * A separate walk from {@link resolveGroupPositions} because it asks a different
 * question — "what is immediately before me" rather than "how many of us are
 * there" — and folding both into one return type would hand two callers a record
 * where each wants one field.
 *
 * `isMember[-1]` is `undefined`, so the first child falls out as `false` without
 * a case of its own.
 *
 * Pure, so the whole matrix is reachable from `bun test`. See AGENTS.md.
 */
export function resolveGroupSeams(isMember: readonly boolean[]): boolean[] {
	return isMember.map((member, index) => member && isMember[index - 1] === true);
}

/**
 * Settles how a press moves the button, from the three places it can come from.
 *
 * **Nearest wins** — the button's own prop, then its group's, then the built-in
 * default: the ladder `Radio` and `Input.Group` already run. `??` rather than
 * `||`, so an explicit `none` is honoured instead of read as an absence.
 *
 * A joined member falls back to `fade` rather than `scale`, and that is not a
 * taste call. A scaling member pulls its own edges in by a point and a half
 * while its neighbours hold still, so the seam the group exists to close tears
 * open for the length of the press. `fade` moves no geometry.
 *
 * A caller still gets `scale` by asking for it, on one button or on a whole
 * group. `pressedScale` beats both, because `resolvePressedState` lets an
 * explicit value win on the axis it names — see `pressable.variants.ts`.
 *
 * Pure, so the whole matrix is reachable from `bun test`. See AGENTS.md.
 */
export function resolveButtonFeedback(
	own: PressableFeedback | undefined,
	group: PressableFeedback | undefined,
	isGrouped: boolean
): PressableFeedback {
	return own ?? group ?? (isGrouped ? BUTTON_GROUP_FEEDBACK : BUTTON_FEEDBACK);
}

export type ButtonVariantProps = VariantProps<typeof buttonVariants>;
