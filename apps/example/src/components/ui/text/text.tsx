import type { ComponentProps, ReactElement } from "react";
import Animated from "react-native-reanimated";
import { TextClassProvider, useTextClass } from "./text.context";
import {
	canNestText,
	resolveTextClass,
	TEXT_MAX_FONT_SIZE_MULTIPLIER,
	type TextAlign,
	type TextColor,
	type TextSize,
	type TextTransform,
	type TextVariant,
	type TextWeight,
} from "./text.variants";

export type TextProps = Omit<ComponentProps<typeof Animated.Text>, "className"> & {
	/** The named role. Omit it and the text inherits, falling back to the base treatment. */
	variant?: TextVariant;
	/** A step on the type scale. Beats the variant's own size. */
	size?: TextSize;
	weight?: TextWeight;
	/**
	 * A page-level text colour. For text drawn on a coloured surface — a button,
	 * a badge — use a `className`: that mapping belongs to the surface.
	 */
	color?: TextColor;
	align?: TextAlign;
	transform?: TextTransform;
	/**
	 * Merged last, so it beats every named axis and anything inherited.
	 *
	 * An arbitrary font size has to be written as a length — `text-[17px]` or
	 * `text-(length:--x)`. A bare `text-[var(--x)]` is ambiguous to
	 * tailwind-merge, which files it under colour, so it will not override the
	 * inherited size.
	 */
	className?: string;
};

/** A preset's props: every axis except the role it already is. */
export type TextPresetProps = Omit<TextProps, "variant">;

function TextRoot({
	align,
	children,
	className,
	color,
	maxFontSizeMultiplier = TEXT_MAX_FONT_SIZE_MULTIPLIER,
	size,
	transform,
	variant,
	weight,
	...props
}: TextProps): ReactElement {
	const inherited = useTextClass();

	const resolved = resolveTextClass({
		align,
		className,
		color,
		inherited,
		isNested: inherited !== undefined,
		size,
		transform,
		variant,
		weight,
	});

	const element = (
		<Animated.Text className={resolved} maxFontSizeMultiplier={maxFontSizeMultiplier} {...props}>
			{children}
		</Animated.Text>
	);

	// A string or number child has no descendant that could read the context, so
	// the provider is skipped rather than rendered once per label. `Text` is the
	// most-instantiated component in an app; this is the common case.
	return canNestText(children) ? <TextClassProvider value={resolved}>{element}</TextClassProvider> : element;
}

/**
 * A screen's one hero line — 30pt bold.
 *
 * Announced as a heading, so a screen reader's rotor stops on it rather than
 * reading it as one more line of body copy.
 */
function TextDisplay(props: TextPresetProps): ReactElement {
	return <TextRoot accessibilityRole="header" variant="display" {...props} />;
}
TextDisplay.displayName = "DelacourUI.Text.Display";

/** A screen or card title — 24pt bold. Announced as a heading. */
function TextTitle(props: TextPresetProps): ReactElement {
	return <TextRoot accessibilityRole="header" variant="title" {...props} />;
}
TextTitle.displayName = "DelacourUI.Text.Title";

/** A section heading — 20pt semibold. Announced as a heading. */
function TextHeader(props: TextPresetProps): ReactElement {
	return <TextRoot accessibilityRole="header" variant="header" {...props} />;
}
TextHeader.displayName = "DelacourUI.Text.Header";

/**
 * The secondary line under a title — 18pt on the muted token.
 *
 * Deliberately not a fourth heading level, and deliberately not announced as
 * one: it restates the title rather than introducing a new section.
 */
function TextSubheader(props: TextPresetProps): ReactElement {
	return <TextRoot variant="subheader" {...props} />;
}
TextSubheader.displayName = "DelacourUI.Text.Subheader";

/**
 * A block of prose — 16pt on the foreground token.
 *
 * The same treatment a bare `<Text>` already renders. It exists so a paragraph
 * *reads* as one at the call site, the way `Button.Label` exists even though a
 * bare string child already produces one.
 */
function TextParagraph(props: TextPresetProps): ReactElement {
	return <TextRoot variant="paragraph" {...props} />;
}
TextParagraph.displayName = "DelacourUI.Text.Paragraph";

/** A control label or compact UI string — 14pt medium. */
function TextLabel(props: TextPresetProps): ReactElement {
	return <TextRoot variant="label" {...props} />;
}
TextLabel.displayName = "DelacourUI.Text.Label";

/** Supporting copy under a label or a title — 14pt on the muted token. */
function TextCaption(props: TextPresetProps): ReactElement {
	return <TextRoot variant="caption" {...props} />;
}
TextCaption.displayName = "DelacourUI.Text.Caption";

/** An eyebrow above a section — 12pt semibold, uppercase, muted. */
function TextOverline(props: TextPresetProps): ReactElement {
	return <TextRoot variant="overline" {...props} />;
}
TextOverline.displayName = "DelacourUI.Text.Overline";

/**
 * Inline emphasis by weight.
 *
 * Emits `font-semibold` and nothing else, so mid-paragraph it comes out at the
 * surrounding text's size and colour. Standing on its own it falls back to the
 * base treatment — React Native's own default colour does not follow the theme.
 */
function TextStrong(props: TextPresetProps): ReactElement {
	return <TextRoot variant="strong" {...props} />;
}
TextStrong.displayName = "DelacourUI.Text.Strong";

/** Inline emphasis by slant. Inherits size, weight and colour from the text around it. */
function TextEmphasis(props: TextPresetProps): ReactElement {
	return <TextRoot variant="emphasis" {...props} />;
}
TextEmphasis.displayName = "DelacourUI.Text.Emphasis";

/**
 * A tappable run of text. `onPress` rides through from React Native's own
 * `TextProps` and works on a nested `<Text>` on both platforms.
 *
 * Painted with `info`, not `primary`: `--primary` is the primary surface
 * colour and sits within a shade of `foreground` in both themes.
 */
function TextLink(props: TextPresetProps): ReactElement {
	return <TextRoot accessibilityRole="link" variant="link" {...props} />;
}
TextLink.displayName = "DelacourUI.Text.Link";

/**
 * Inline code, monospaced on a muted background.
 *
 * Padded and rounded only when it stands alone. A nested `<Text>` is laid out
 * by the platform's text engine rather than by Yoga — an `NSAttributedString`
 * run on iOS, a `Span` on Android — and both ignore padding, margin and border
 * radius outright, so only the background survives. For a code *block*, wrap it:
 *
 * @example
 * <View className="rounded-lg bg-muted p-3">
 *   <Text.Code className="bg-transparent" size="sm">bun run gen-exports</Text.Code>
 * </View>
 */
function TextCode(props: TextPresetProps): ReactElement {
	return <TextRoot variant="code" {...props} />;
}
TextCode.displayName = "DelacourUI.Text.Code";

/**
 * A piece of text, and the type scale the whole library draws from.
 *
 * Every `Text` publishes its own resolved classes to its subtree, so a nested
 * `<Text>` inherits the treatment around it and overrides only the axes it
 * names — which is what React Native does natively with a nested `<Text>`'s
 * style, and what Uniwind breaks by compiling each `className` independently.
 *
 * Precedence, weakest first: the base treatment, the inherited class, this
 * text's own named axes, then its `className`.
 *
 * Anything can publish into that cascade, not just a `Text` — `Button` wraps its
 * children in a `TextClassProvider` carrying the label's treatment, so a bare
 * `<Text>` composed into one needs nothing at the call site. The same idea as
 * `IconDefaultsProvider`, and the same single path.
 *
 * OS font scaling is respected and capped at {@link TEXT_MAX_FONT_SIZE_MULTIPLIER};
 * both `allowFontScaling` and `maxFontSizeMultiplier` remain overridable.
 *
 * @example
 * <Text.Title>Total <Text color="muted">USD</Text></Text.Title>
 *
 * @example
 * <Text.Paragraph>
 *   Run <Text.Code>bun test</Text.Code> before you <Text.Strong>commit</Text.Strong>.
 * </Text.Paragraph>
 *
 * @example
 * // No `asChild`: a Text's child is usually a string, which `Slot` cannot take
 * // props. Read the cascade directly instead.
 * <Animated.Text className={useTextClass()} style={fadeStyle} />
 */
export const Text = Object.assign(TextRoot, {
	/** A screen's one hero line — 30pt bold. Announced as a heading. */
	Display: TextDisplay,
	/** A screen or card title — 24pt bold. Announced as a heading. */
	Title: TextTitle,
	/** A section heading — 20pt semibold. Announced as a heading. */
	Header: TextHeader,
	/** The secondary line under a title — 18pt muted. Not a fourth heading level. */
	Subheader: TextSubheader,
	/** A block of prose — 16pt. The same treatment a bare `<Text>` renders. */
	Paragraph: TextParagraph,
	/** A control label or compact UI string — 14pt medium. */
	Label: TextLabel,
	/** Supporting copy — 14pt on the muted token. */
	Caption: TextCaption,
	/** An eyebrow above a section — 12pt semibold, uppercase, muted. */
	Overline: TextOverline,
	/** Inline emphasis by weight. Inherits size and colour from the text around it. */
	Strong: TextStrong,
	/** Inline emphasis by slant. Inherits size, weight and colour from the text around it. */
	Emphasis: TextEmphasis,
	/** A tappable run of text, on the `info` token. Takes `onPress`. */
	Link: TextLink,
	/** Inline code, monospaced. Padded only when it stands alone. */
	Code: TextCode,
	displayName: "DelacourUI.Text",
});
