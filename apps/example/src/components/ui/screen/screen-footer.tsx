import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { type LayoutChangeEvent, View } from "react-native";
import { KeyboardStickyView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeyboardAnimationGuard } from "@/hooks/use-keyboard-state-sync";
import { useScreenDebug, useScreenPart } from "./screen.context";
import type { ScreenPlacementProps } from "./screen.types";
import { SCREEN_FLOATING_BOTTOM_GAP, SCREEN_FOOTER_PADDING, screenVariants } from "./screen.variants";
import { SCREEN_DEBUG_COLORS } from "./screen-debug";
import { ScreenFooterBackground } from "./screen-footer-background";

export type ScreenFooterProps = ScreenPlacementProps & {
	/**
	 * Ride the keyboard, so the footer stays directly above it. Off by default —
	 * a footer holding a submit button wants to stay put, while one holding a
	 * composer does not.
	 */
	sticky?: boolean;
	/**
	 * Fade the top hairline out as the content runs out, instead of drawing it at
	 * rest.
	 *
	 * The mirror of `Screen.Navbar`'s `fadeBorderOnScroll`, and off by default
	 * for the same reason: the line separates chrome from content, and content
	 * sitting right against the footer wants it from the first frame. Turn it on
	 * for a footer that should read as joined to the content once there is
	 * nothing left to scroll to.
	 *
	 * Only applies to a `static` footer — an overlay one draws no hairline.
	 *
	 * @default false
	 */
	fadeBorderOnScroll?: boolean;
	/**
	 * Whether the enclosing screen is the focused one. Defaults to `true`.
	 *
	 * A sticky footer on a backgrounded screen would otherwise follow a keyboard
	 * opened on the screen in front of it. This library takes no navigation
	 * dependency, so an app that has one passes its own signal — expo-router and
	 * React Navigation both expose `useIsFocused()`.
	 */
	isFocused?: boolean;
};

/**
 * A pinned region at the bottom of a screen, optionally riding the keyboard.
 *
 * Measures its CONTENT height — excluding its own padding and the safe-area
 * band — into the screen context, so a scrollable can reserve exactly what the
 * footer covers. `footerOccupancy` in `screen.variants` adds the rest back; the
 * two must agree, which is why the padding is applied from the same constants
 * rather than as a class.
 *
 * The VERTICAL padding is a style rather than a class for that reason alone. A
 * class is unreadable from JS, so the reserve would have to restate the number
 * and the two could drift — the failure being a list whose last row hides under the
 * footer only on some devices.
 *
 * Four nested boxes, each with one job:
 * 1. the positioned outer view, which the caller's `className` reaches;
 * 2. `KeyboardStickyView`, which translates and carries the footer's padding;
 * 3. the backing and its top hairline, filling the sticky view behind the rest;
 * 4. the measured content box, whose height reaches the screen context.
 *
 * The backing lives INSIDE the sticky view, not on the positioned outer one, so
 * it travels with the translation. A static footer lifted over the content by
 * the keyboard would otherwise let that content show straight through it — the
 * buttons legible only where they happened to overlap blank space.
 *
 * The sticky view sits *inside* the positioned view rather than being it, so
 * this file needs no `withUniwind` wrapper — it takes a `style` and never a
 * `className`. See AGENTS.md rule 6.
 *
 * @example
 * <Screen.Footer>
 *   <Button onPress={save}>Save</Button>
 * </Screen.Footer>
 *
 * @example
 * <Screen.Footer sticky>
 *   <MessageComposer />
 * </Screen.Footer>
 */
export function ScreenFooter({
	placement = "overlay",
	sticky = false,
	fadeBorderOnScroll = false,
	isFocused = true,
	className,
	children,
	style,
	...props
}: ScreenFooterProps): ReactElement {
	const { footer } = useScreenPart("Screen.Footer");
	const slots = screenVariants({ placement });
	const { bottom } = useSafeAreaInsets();
	const keyboardState = useKeyboardState();
	const debug = useScreenDebug();
	// The shared keyboard values are a global with no per-screen reset, so a
	// footer can mount into a state left "open" by a keyboard that vanished
	// without a `keyboardWillHide` — and then float a keyboard-height off the
	// bottom of a screen with no keyboard on it. Repair on mount; a no-op
	// whenever an input is genuinely focused, which is what keeps the
	// `isKeyboardOpen` hand-off below working.
	useKeyboardAnimationGuard();

	// Sticking before the first measure would translate a zero-height box.
	const [hasMeasured, setHasMeasured] = useState(false);
	// A JS ref, never a SharedValue read in a memoized closure: React Compiler
	// hoists such loads into memo-cache comparisons that run during render,
	// which is a Reanimated strict-mode violation.
	const hasCapturedBaselineRef = useRef(false);

	// A screen navigated away from while its keyboard is still up has to keep
	// reacting, or its footer snaps down behind the outgoing transition.
	const isEnabled = sticky && hasMeasured && (isFocused || keyboardState.isVisible);

	const handleContentLayout = useCallback(
		(event: LayoutChangeEvent) => {
			const { height } = event.nativeEvent.layout;
			setHasMeasured(true);
			footer.height.value = height;
			if (!hasCapturedBaselineRef.current) {
				hasCapturedBaselineRef.current = true;
				footer.initialHeight.value = height;
			}
		},
		[footer]
	);

	useEffect(() => {
		footer.placement.value = placement;
	}, [placement, footer.placement]);

	useEffect(() => {
		return () => {
			footer.height.value = 0;
			footer.initialHeight.value = 0;
			hasCapturedBaselineRef.current = false;
		};
	}, [footer.height, footer.initialHeight]);

	return (
		<View className={slots.footer({ className })} style={style} {...props}>
			<KeyboardStickyView
				enabled={isEnabled}
				// Shift by the inset rather than animating the padding away: the
				// footer's safe-area band is meaningless once the keyboard covers it,
				// and animating padding leaves a visible gap between the two
				// mid-transition.
				offset={{ closed: 0, opened: bottom }}
				style={{ paddingBottom: SCREEN_FLOATING_BOTTOM_GAP, paddingTop: SCREEN_FOOTER_PADDING }}
			>
				<ScreenFooterBackground fadeOnScroll={fadeBorderOnScroll} placement={placement} />
				<View
					style={[{ paddingBottom: bottom }, debug ? { backgroundColor: SCREEN_DEBUG_COLORS.footerSafeArea } : null]}
				>
					<View
						className={slots.footerContent()}
						onLayout={handleContentLayout}
						style={debug ? { backgroundColor: SCREEN_DEBUG_COLORS.footerContent } : undefined}
					>
						{children}
					</View>
				</View>
			</KeyboardStickyView>
		</View>
	);
}
ScreenFooter.displayName = "DelacourUI.Screen.Footer";
