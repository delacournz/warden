import { type ReactElement, type ReactNode, useMemo } from "react";
import { View, type ViewProps } from "react-native";
import { type SurfaceContextValue, SurfaceProvider, useSurfaceContext } from "./surface.context";
import {
	resolveSurfacePlane,
	resolveSurfaceVariant,
	type SurfacePadding,
	type SurfaceVariant,
	surfaceVariants,
} from "./surface.variants";

export type SurfaceProps = ViewProps & {
	/**
	 * The fill. Omitted, a top-level surface is the `default` card and a nested
	 * one steps to the next fill, so it never vanishes into the surface it sits on.
	 */
	variant?: SurfaceVariant;
	/** Inner spacing. `none` also clips, for content bled to the corners. */
	padding?: SurfacePadding;
	className?: string;
	children?: ReactNode;
};

/**
 * A rounded container on one of the theme's surface fills — the plane a card,
 * an alert or a settings panel is drawn on.
 *
 * The variants are a ladder rather than a palette. `default` is the card,
 * hairlined so it holds its edge on the page; `secondary` and `tertiary` are
 * the fills beneath it; `transparent` keeps the padding and corner and paints
 * nothing. A surface that names no variant reads the one it sits in and steps
 * to the next fill, so nesting builds depth without naming a colour.
 *
 * It publishes no text treatment. `Text`'s presets already carry their own
 * colour, so a class cascade would reach only a bare `Text` — and
 * would mark every `Text` beneath it as nested, which strips `Text.Code` of its
 * chip. A caller that wants the fill's own token reads
 * `SURFACE_FOREGROUND_TOKENS[useSurface().plane]`.
 *
 * @example
 * <Surface>
 *   <Text.Label>Account</Text.Label>
 *   <Surface className="mt-3">
 *     <Text color="muted">Signed in as sam@example.com</Text>
 *   </Surface>
 * </Surface>
 *
 * @example
 * <Surface padding="none">
 *   <Image className="h-40 w-full" source={cover} />
 * </Surface>
 */
export function Surface({ variant, padding = "md", className, children, ...props }: SurfaceProps): ReactElement {
	const parent = useSurfaceContext();
	const parentPlane = parent?.plane ?? null;

	const resolved = resolveSurfaceVariant({ parentPlane, variant });
	const plane = resolveSurfacePlane({ parentPlane, variant: resolved });

	const context = useMemo<SurfaceContextValue>(() => ({ plane, variant: resolved }), [plane, resolved]);

	return (
		<SurfaceProvider value={context}>
			<View className={surfaceVariants({ padding, variant: resolved }).root({ className })} {...props}>
				{children}
			</View>
		</SurfaceProvider>
	);
}
Surface.displayName = "DelacourUI.Surface";
