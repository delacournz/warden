import type { ComponentType, ReactElement } from "react";
import type { SvgProps } from "react-native-svg";
import { withUniwind } from "uniwind";
import { useThemeColor } from "@/hooks/use-theme-color";
import { useIconDefaults } from "./icon.context";
import { ICON_FALLBACK_COLOR, type IconSize, isIconSize, resolveIconSizeClass } from "./icon.variants";

export type IconComponent = ComponentType<SvgProps & { size?: number | string }>;

export type IconProps = Omit<SvgProps, "color" | "width" | "height"> & {
	/** An icon component from `@/lib/icons/central`. */
	icon: IconComponent;
	/** A named size, or an edge length in points. A number beats `className`. */
	size?: IconSize | number;
	/**
	 * A theme colour token (`foreground`, `muted-foreground`, …) or a CSS
	 * variable name. Defaults to the enclosing component's icon colour.
	 */
	color?: string;
	/** A `size-*` utility. Beats a named `size`, loses to a numeric one. */
	className?: string;
};

type IconGlyphProps = Omit<SvgProps, "color" | "width" | "height"> & {
	glyph: IconComponent;
	size?: number | string;
	color?: string;
	className?: string;
};

/**
 * Renders the glyph and drops the className that sized it.
 *
 * This one indirection is what keeps the whole Central Icons set to a *single*
 * `withUniwind` wrapper: the wrapper goes on this component, which takes the
 * glyph as data, rather than on each of the two thousand icon components.
 * AGENTS.md rule 7 caps a component at one wrapper in one file — this is it.
 *
 * The className must not reach the glyph. `withManualUniwind` spreads the
 * original props straight through, and `CentralIconBase` would forward a stray
 * `className` onto the native SVG view, where nothing interprets it.
 */
function IconGlyph({ glyph: Glyph, className: _sizedBy, ...props }: IconGlyphProps): ReactElement {
	return <Glyph {...props} />;
}
IconGlyph.displayName = "DelacourUI.Icon.Glyph";

/**
 * Turns a `size-*` class into the glyph's `size` **prop**.
 *
 * A className cannot size an SVG through a style: `CentralIconBase` spreads its
 * props onto `<Svg>` before its own `width`/`height`, and `Svg.render` pushes
 * the width/height-derived styles on last, beating anything a className set.
 *
 * `withManualUniwind` reads `props.className`, compiles it, and writes
 * `styles.width` to `size` — but skips the mapping entirely when `size` is
 * already defined. That skip *is* the precedence rule: a numeric `size` from the
 * caller wins and the class is ignored.
 *
 * Created once at module scope. Calling `withUniwind` inside a render would mint
 * a new component type every frame and remount the icon.
 */
const StyledIconGlyph = withUniwind(IconGlyph, {
	size: { fromClassName: "className", styleProperty: "width" },
});

/**
 * Renders a Central Icon at a theme-aware size and colour.
 *
 * An icon's size is a class and an icon's colour is a token — a class cannot
 * express a literal like `#EC4899` or reach an SVG paint prop, so colour is
 * resolved through the active theme instead. See AGENTS.md.
 *
 * Both fall back to the nearest {@link IconDefaultsProvider}, so an icon
 * composed into a Button matches that button's size and variant without being
 * told to. An explicit `size` or `color` still wins.
 */
export function Icon({ icon, size, color, className, ...props }: IconProps): ReactElement {
	const defaults = useIconDefaults();
	const resolvedColor = useThemeColor(color ?? defaults?.color ?? ICON_FALLBACK_COLOR);

	return (
		<StyledIconGlyph
			className={resolveIconSizeClass({ className, inherited: defaults?.className, size })}
			color={resolvedColor}
			glyph={icon}
			size={isIconSize(size) ? undefined : size}
			{...props}
		/>
	);
}
Icon.displayName = "DelacourUI.Icon";
