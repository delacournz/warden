import { type ReactElement, type ReactNode, useCallback, useEffect } from "react";
import { type LayoutChangeEvent, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useScreenPart } from "./screen.context";
import type { ScreenPlacementProps } from "./screen.types";
import { screenVariants } from "./screen.variants";
import { ScreenNavbarBackButton } from "./screen-navbar-back-button";
import { ScreenNavbarBackground } from "./screen-navbar-background";
import { ScreenNavbarSubtitle } from "./screen-navbar-subtitle";
import { ScreenNavbarTitle } from "./screen-navbar-title";

export type ScreenNavbarProps = ScreenPlacementProps & {
	/** Leading content — a back button, a title, an avatar row. */
	children?: ReactNode;
	/** Trailing content, laid out in a row against the right edge. */
	actions?: ReactNode;
	/**
	 * Content centred across the full width, independent of what the leading and
	 * trailing slots take. Absolutely positioned, so a long title on one side
	 * cannot push it off centre.
	 */
	center?: ReactNode;
	/** Classes for the navbar's opaque backing, to tint or blur it. */
	backgroundClassName?: string;
	/**
	 * Ramp the bottom hairline in as the screen scrolls, instead of drawing it at
	 * rest.
	 *
	 * Off by default: a screen whose content starts flush against the bar wants
	 * the line from the first frame. Turn it on for a header that should read as
	 * undivided until the content moves — which only says anything on a screen
	 * that scrolls, since the value it reads is published by the scrollable.
	 *
	 * @default false
	 */
	fadeBorderOnScroll?: boolean;
};

/**
 * The bar pinned to the top of a screen.
 *
 * Measures its own height — safe-area band included — into the screen context,
 * so every scrollable reserves exactly what it covers rather than each screen
 * guessing a number. That measurement is the reason this cannot be a standalone
 * component: it only means anything inside a `<Screen>`.
 *
 * `overlay` by default, so content scrolls under it and the hairline appearing
 * on scroll says there is more above. `placement="static"` puts it in the flow
 * instead, for a screen whose content should never pass beneath it.
 *
 * The bottom hairline is drawn at rest. `fadeBorderOnScroll` ramps it in with
 * the content instead, for a header that should read as undivided until the
 * screen moves.
 *
 * Every layout box is `pointerEvents="box-none"`, so the bar itself never
 * swallows a tap meant for the content beneath — only its actual controls do.
 * The centre slot in particular spans the full width and would otherwise block
 * both the leading and trailing controls.
 *
 * Actions are composed rather than configured: pass whatever the screen needs.
 * A `Button` already covers the icon-button case, so there is no `Navbar.Action`
 * restating its loading, sizing and haptics vocabulary.
 *
 * @example
 * <Screen.Navbar>
 *   <Screen.Navbar.BackButton onPress={() => router.back()}>
 *     <Screen.Navbar.Title>Settings</Screen.Navbar.Title>
 *   </Screen.Navbar.BackButton>
 * </Screen.Navbar>
 *
 * @example
 * <Screen.Navbar
 *   actions={
 *     <Button accessibilityLabel="Search" size="icon-sm" variant="secondary" onPress={search}>
 *       <Icon icon={IconSearch} />
 *     </Button>
 *   }
 *   center={<Screen.Navbar.Title>Inbox</Screen.Navbar.Title>}
 *   placement="static"
 * />
 */
function ScreenNavbarRoot({
	placement = "overlay",
	className,
	backgroundClassName,
	fadeBorderOnScroll = false,
	children,
	actions,
	center,
	onLayout,
	...props
}: ScreenNavbarProps): ReactElement {
	const { navbar } = useScreenPart("Screen.Navbar");
	// Not uniwind's `pt-safe`: that compiles to env(safe-area-inset-top), which
	// resolves to zero on React Native and would silently draw the bar over the
	// status bar. The hook is also what the footer reads, so the two agree.
	const { top } = useSafeAreaInsets();

	const handleLayout = useCallback(
		(event: LayoutChangeEvent) => {
			onLayout?.(event);
			navbar.height.value = event.nativeEvent.layout.height;
		},
		[navbar, onLayout]
	);

	useEffect(() => {
		navbar.placement.value = placement;
	}, [placement, navbar.placement]);

	return (
		<View
			className={screenVariants({ placement }).navbar({ className })}
			onLayout={handleLayout}
			pointerEvents="box-none"
			{...props}
		>
			<ScreenNavbarBackground className={backgroundClassName} fadeOnScroll={fadeBorderOnScroll} />
			<View pointerEvents="box-none" style={{ paddingTop: top }}>
				<View className={screenVariants().navbarRow()} pointerEvents="box-none">
					<View className={screenVariants().navbarStart()} pointerEvents="box-none">
						{children}
					</View>
					{actions ? (
						<View className={screenVariants().navbarActions()} pointerEvents="box-none">
							{actions}
						</View>
					) : null}
					{center ? (
						<View className={screenVariants().navbarCenter()} pointerEvents="box-none">
							{center}
						</View>
					) : null}
				</View>
			</View>
		</View>
	);
}

/**
 * The bar pinned to the top of a screen, with its title and back button slots.
 *
 * Reached as `Screen.Navbar`; see {@link ScreenNavbarRoot} for the layout and
 * the measurement it publishes.
 */
export const ScreenNavbar = Object.assign(ScreenNavbarRoot, {
	/** The primary line. A string child is wrapped in a `Text`; any other node passes through. */
	Title: ScreenNavbarTitle,
	/** The secondary line, a step down in scale and on the muted token. */
	Subtitle: ScreenNavbarSubtitle,
	/** The leading control. Takes an `onPress` — this library wires no router of its own. */
	BackButton: ScreenNavbarBackButton,
	displayName: "DelacourUI.Screen.Navbar",
});
