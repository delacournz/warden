import type { VariantProps } from "tailwind-variants";
import { cn } from "@/lib/cn";
import { tv } from "@/lib/tv";

/**
 * The named text roles, block presets first and largest first.
 *
 * Order carries meaning for the block half — the tests read it to assert the
 * type scale descends — so a new block role goes in at its step rather than on
 * the end.
 */
export const TEXT_VARIANTS = [
	"display",
	"title",
	"header",
	"subheader",
	"paragraph",
	"label",
	"caption",
	"overline",
	"strong",
	"emphasis",
	"link",
	"code",
] as const;

/**
 * Presets that emit only a delta — a weight, a slant, a decoration, a family —
 * and inherit size, colour and weight from the `Text` they sit inside.
 *
 * This is what makes `<Text.Paragraph>Hi <Text.Strong>there</Text.Strong></Text.Paragraph>`
 * come out at the paragraph's size and colour instead of snapping back to a
 * base of its own.
 */
export const TEXT_INLINE_VARIANTS = ["strong", "emphasis", "link", "code"] as const;

export const TEXT_SIZES = ["xs", "sm", "md", "lg", "xl", "2xl", "3xl"] as const;
export const TEXT_WEIGHTS = ["normal", "medium", "semibold", "bold"] as const;
export const TEXT_COLORS = ["default", "muted", "destructive", "success", "warning", "info"] as const;
export const TEXT_ALIGNS = ["left", "center", "right"] as const;
export const TEXT_TRANSFORMS = ["none", "uppercase", "lowercase", "capitalize"] as const;

export type TextVariant = (typeof TEXT_VARIANTS)[number];
export type TextInlineVariant = (typeof TEXT_INLINE_VARIANTS)[number];
export type TextSize = (typeof TEXT_SIZES)[number];
export type TextWeight = (typeof TEXT_WEIGHTS)[number];
export type TextColor = (typeof TEXT_COLORS)[number];
export type TextAlign = (typeof TEXT_ALIGNS)[number];
export type TextTransform = (typeof TEXT_TRANSFORMS)[number];

/**
 * The treatment a `Text` falls back to on every axis nothing else names.
 *
 * First in {@link resolveTextClass}'s chain and therefore the weakest source, so
 * it never fights an inherited class or a named axis. It is applied
 * unconditionally — including inside a nested `Text` — and that is deliberate.
 *
 * For a nested `Text` it is a no-op: the parent's resolved class came out of
 * this same function and already names all three axes, so tailwind-merge drops
 * every class here. It only does work under a *partial* provider — a `Button`
 * publishing nothing but `text-primary-foreground`, say. Guarding it behind "am
 * I nested" would leave that `Text` with a colour and no size at all, silently
 * collapsing to React Native's own 14pt default.
 *
 * It names the three axes React Native inherits natively and cannot default
 * sensibly on its own — weight, size, colour — plus the family.
 *
 * `font-sans` is what makes the typeface themeable at all: it resolves
 * `--font-sans`, which `theme.css` declares per platform and an app may retune
 * at runtime. Without it a `Text` carries no `fontFamily` and the platform
 * default stands however the variable is set. It is FIRST in the chain, so
 * `Text.Code`'s `font-mono` and the headings' `font-heading` — emitted later by
 * `textVariants`, in the same tailwind-merge group — both still win.
 */
export const TEXT_BASE_CLASS = "font-sans font-normal text-base text-foreground";

/**
 * Cap on OS font scaling.
 *
 * Accessibility text sizes are respected — `allowFontScaling` is left at React
 * Native's default — but the library's fixed-height chrome cannot grow with
 * them: `h-button-sm|md|lg` are hard 36/44/52pt and `h-navbar-row` is 56pt, so
 * an uncapped multiplier clips a label rather than enlarging it.
 */
export const TEXT_MAX_FONT_SIZE_MULTIPLIER = 1.4;

/**
 * Styling for one piece of text, on six independent axes.
 *
 * ## Order is the design
 *
 * `tv` emits variants in the order their keys are declared here, then the
 * compound variants, then the caller's `className`. `variant` is FIRST because
 * a preset is the weakest named source: `<Text.Header size="sm">` has to come
 * out at 14pt. The axes after it touch different tailwind-merge groups, so
 * their order relative to each other means nothing.
 *
 * ## No `defaultVariants`, on purpose
 *
 * A `defaultVariants: { size: "md" }` would emit `text-base` from THIS call,
 * after `variant` and therefore ahead of it in the merge — every preset's size
 * would be overwritten by the default. More importantly an axis the caller did
 * not name has to emit *nothing*, so it falls through to the class the
 * enclosing `Text` published. That is what reproduces React Native's own
 * cascade. `iconVariants` avoids the same trap for the same reason; the
 * fallback lives in {@link TEXT_BASE_CLASS} instead.
 *
 * ## A variant names type, never a line height
 *
 * tailwind-merge lists `leading` among `font-size`'s conflicting groups, so a
 * `text-lg` from the `size` axis silently strips a `leading-6` written beside a
 * `text-base` here — no error, just a paragraph that loses its leading the
 * moment someone resizes it. Tailwind v4's `--text-*--line-height` companions
 * survive `tokens.css`'s size-only overrides, so every step already carries a
 * paired leading. If prose ever needs its own, add a `--text-paragraph` /
 * `--text-paragraph--line-height` *pair* in `tokens.css` and register the
 * bespoke name in `tokens.ts` — one utility carrying both.
 *
 * Free of React Native imports so it stays unit-testable — `bun test` cannot
 * parse React Native's Flow-typed source. See AGENTS.md.
 */
export const textVariants = tv({
	variants: {
		variant: {
			// The three block headings, and the only presets that read
			// `--font-heading`. It defaults to the same family as `--font-sans`,
			// so pairing a display face with body text is opt-in for an app
			// rather than something this package decides.
			display: "font-heading font-bold text-3xl text-foreground",
			title: "font-heading font-bold text-2xl text-foreground",
			header: "font-heading font-semibold text-xl text-foreground",
			// A step down from the title it sits under, not a fourth heading
			// level — which is why it is muted and carries no weight of its own.
			subheader: "text-lg text-muted-foreground",
			paragraph: "text-base text-foreground",
			label: "font-medium text-sm text-foreground",
			caption: "text-sm text-muted-foreground",
			overline: "font-semibold text-muted-foreground text-xs uppercase tracking-wide",
			// The four below emit a delta and nothing else. See TEXT_INLINE_VARIANTS.
			strong: "font-semibold",
			emphasis: "italic",
			// `text-info`, never `text-primary`. `--primary` is the primary
			// SURFACE — #262626 light, #f5f5f5 dark — so a link painted with it
			// would be indistinguishable from the foreground it sits in.
			link: "text-info underline",
			code: "bg-muted font-mono",
		},
		// The empty branches are load-bearing typing, not placeholders: a map with
		// only `true` types the prop as `true` rather than `boolean`. The compound
		// below matches without them — `tv` compares against `defaultVariants` plus
		// props and never reads this map. See the note in button.variants.ts.
		isNested: { true: "", false: "" },
		size: {
			xs: "text-xs",
			sm: "text-sm",
			// `md` rather than Tailwind's own `base`, so one step name means "the
			// default step" across Icon, Spinner, Button, ListGroup and Text. The
			// token underneath is still `--text-base`.
			md: "text-base",
			lg: "text-lg",
			xl: "text-xl",
			"2xl": "text-2xl",
			"3xl": "text-3xl",
		},
		weight: {
			normal: "font-normal",
			medium: "font-medium",
			semibold: "font-semibold",
			bold: "font-bold",
		},
		// Page-level text colours only. Text drawn ON a coloured surface is that
		// surface component's job — BUTTON_FOREGROUND_TOKEN already maps a variant
		// to its foreground, and a second copy of that map here could drift from
		// it. A caller on a coloured surface writes the utility directly.
		color: {
			default: "text-foreground",
			muted: "text-muted-foreground",
			destructive: "text-destructive",
			success: "text-success",
			warning: "text-warning",
			info: "text-info",
		},
		// `left`/`right`, never `start`/`end`: React Native's `textAlign` accepts
		// auto | left | right | center | justify and nothing else, so Tailwind v4's
		// logical-property utilities would resolve to a value RN rejects.
		align: { left: "text-left", center: "text-center", right: "text-right" },
		transform: {
			// `normal-case` rather than an empty string, so `transform="none"` can
			// actually clear an inherited or preset `uppercase`.
			none: "normal-case",
			uppercase: "uppercase",
			lowercase: "lowercase",
			capitalize: "capitalize",
		},
	},
	compoundVariants: [
		// A standalone `Text.Code` is an ordinary Yoga box and takes padding. A
		// NESTED one is a run inside the platform text engine — iOS lays it out as
		// an NSAttributedString, Android as a Span — and both ignore padding,
		// margin and border radius on an inner `<Text>` outright. Only the
		// background survives, drawn tight to the glyphs with square corners.
		{ variant: "code", isNested: false, class: "rounded-md px-1.5 py-0.5" },
	],
});

/** Whether a preset emits only a delta and inherits the rest from the `Text` above it. */
export function isInlineTextVariant(variant: TextVariant): boolean {
	return (TEXT_INLINE_VARIANTS as readonly string[]).includes(variant);
}

/**
 * Whether a `Text` with these children can hold a nested `Text` at all.
 *
 * A string or number child has no descendant component, so nothing below could
 * read the context — publishing it would render a provider element per label
 * for the most-instantiated component in the library. `false` here is provable
 * rather than a guess, which is what makes skipping the provider safe.
 *
 * Deliberately typed on `unknown` rather than `ReactNode`: keeping this module
 * free of even a type import is what lets `bun test` reach it.
 */
export function canNestText(children: unknown): boolean {
	return typeof children !== "string" && typeof children !== "number";
}

/**
 * The class chain that styles one piece of text, weakest source first.
 *
 * | Source | How it wins |
 * | --- | --- |
 * | {@link TEXT_BASE_CLASS} | first in the chain |
 * | the class inherited from the enclosing `Text` or `TextClassProvider` | second |
 * | this `Text`'s own named axes | third |
 * | the caller's `className` | last |
 *
 * This is what replaces React Native's native text inheritance. Natively a
 * nested `<Text>` inherits the parent's *style object* and overrides only the
 * keys it sets; here every `Text` compiles its own className, so the parent's
 * resolved class has to be threaded through and beaten per-axis rather than
 * wholesale. The chain does that: an axis the child names wins, an axis it
 * leaves alone falls through.
 *
 * The property that makes nesting correct is a fixpoint — for every `x` this
 * function can produce, `resolveTextClass({ inherited: x })` is exactly `x`, at
 * any depth. The tests assert it across the matrix.
 *
 * Precedence is the ladder `Icon` and `Spinner` already follow, so a `Text`
 * composed into a `Button` matches it without being told to. See
 * `resolveIconSizeClass`.
 *
 * Pure, so the whole ladder is reachable from `bun test`. See AGENTS.md.
 */
export function resolveTextClass({
	align,
	className,
	color,
	inherited,
	isNested = false,
	size,
	transform,
	variant,
	weight,
}: {
	align?: TextAlign;
	className?: string;
	color?: TextColor;
	inherited?: string;
	isNested?: boolean;
	size?: TextSize;
	transform?: TextTransform;
	variant?: TextVariant;
	weight?: TextWeight;
}): string {
	return cn(
		TEXT_BASE_CLASS,
		inherited,
		textVariants({ align, color, isNested, size, transform, variant, weight }),
		className
	);
}

export type TextVariantProps = VariantProps<typeof textVariants>;
