import { Children, type ComponentProps, isValidElement, type ReactElement, type ReactNode, useMemo } from "react";
import Animated, { Easing, FadeIn, FadeOut } from "react-native-reanimated";
import { useThemeColor } from "@/hooks/use-theme-color";
import { IconDefaultsProvider, useIconDefaults } from "@/components/ui/icon";
import { type SpinnerContextValue, SpinnerProvider } from "./spinner.context";
import {
	resolveSpinnerColor,
	resolveSpinnerRootClass,
	SPINNER_GLYPH_SIZE_CLASS,
	type SpinnerColor,
	type SpinnerSize,
} from "./spinner.variants";
import { SpinnerContent } from "./spinner-content";

const ENTERING = FadeIn.duration(200).easing(Easing.out(Easing.ease));
const EXITING = FadeOut.duration(100);

export type SpinnerProps = Omit<ComponentProps<typeof Animated.View>, "children" | "style"> & {
	/** A named size, or an edge length in points. Defaults to the enclosing component's icon size. */
	size?: SpinnerSize | number;
	/**
	 * A named colour, any theme token the active theme defines
	 * (`primary-foreground`, `muted-foreground`) or a literal (`#EC4899`).
	 * Defaults to the enclosing component's icon colour.
	 */
	color?: SpinnerColor | (string & {});
	/** Whether the spinner is shown. Fades out when flipped off. */
	isLoading?: boolean;
	/** Rotation speed multiplier. 1 is one full turn per 900ms. */
	speed?: number;
	className?: string;
	children?: ReactNode;
};

function SpinnerRoot({
	size,
	color,
	isLoading = true,
	speed = 1,
	className,
	children,
	...props
}: SpinnerProps): ReactElement | null {
	// One inheritance path, not two. A Button wraps its whole subtree — the
	// spinner it composes in included — in an `IconDefaultsProvider` carrying
	// that button's icon class and its variant's foreground, so reading the
	// button's own context here would recompute the same two values.
	const iconDefaults = useIconDefaults();

	// A number is not a class: Tailwind's scanner is static, so a runtime
	// `size-[40px]` is never compiled. The numeric escape hatch rides `style`.
	const numericSize = typeof size === "number" ? size : undefined;

	const rootClassName = resolveSpinnerRootClass({ className, inherited: iconDefaults?.className, size });
	const colorToken = resolveSpinnerColor(color, iconDefaults?.color);
	const resolvedColor = useThemeColor(colorToken);

	const context = useMemo<SpinnerContextValue>(
		() => ({ color: resolvedColor, isLoading, speed }),
		[resolvedColor, isLoading, speed]
	);

	// A glyph composed into the spinner adopts these unless told otherwise. It
	// fills rather than taking a step, so it matches at a numeric size too.
	const iconContext = useMemo(() => ({ className: SPINNER_GLYPH_SIZE_CLASS, color: colorToken }), [colorToken]);

	const content = useMemo(() => wrapSpinnerChildren(children), [children]);

	if (!isLoading) return null;

	return (
		<SpinnerProvider value={context}>
			<Animated.View
				accessibilityRole="progressbar"
				accessibilityState={{ busy: true }}
				className={rootClassName}
				entering={ENTERING}
				exiting={EXITING}
				style={numericSize === undefined ? undefined : { height: numericSize, width: numericSize }}
				{...props}
			>
				<IconDefaultsProvider value={iconContext}>{content}</IconDefaultsProvider>
			</Animated.View>
		</SpinnerProvider>
	);
}

/**
 * Wraps a bare glyph in a `Spinner.Content` so it rotates.
 *
 * Without this, `<Spinner><Icon … /></Spinner>` would render a motionless icon:
 * the rotation lives on `Spinner.Content`, not on the root. A caller who passes
 * `Spinner.Content` themselves is left alone, since they own the rotation.
 */
function wrapSpinnerChildren(children: ReactNode): ReactNode {
	if (children === undefined || children === null) return <SpinnerContent />;

	const items = Children.toArray(children);
	const hasContent = items.some((child) => isValidElement(child) && child.type === SpinnerContent);

	return hasContent ? children : <SpinnerContent>{children}</SpinnerContent>;
}

/**
 * An animated loading indicator, composed from parts rather than configured by
 * flags.
 *
 * Size and colour are inherited, not passed. Inside a `Button` the spinner
 * reads that button's context and comes out at its icon size in its variant's
 * foreground; elsewhere it falls back to the nearest `IconDefaultsProvider`,
 * then to `md` on `foreground`. An explicit `size` or `color` always wins.
 *
 * Any child becomes the glyph and is wrapped in a `Spinner.Content` so it still
 * rotates, so a custom icon or asset needs nothing but to be passed in.
 *
 * @example
 * <Spinner size="lg" color="success" />
 *
 * @example
 * <Spinner speed={0.7}>
 *   <Icon icon={IconArrowsRepeat} />
 * </Spinner>
 */
export const Spinner = Object.assign(SpinnerRoot, {
	/** The rotating layer. Wraps a custom glyph or asset so it spins; applied automatically. */
	Content: SpinnerContent,
	displayName: "DelacourUI.Spinner",
});
