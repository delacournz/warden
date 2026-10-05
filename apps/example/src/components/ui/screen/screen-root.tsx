import type { ReactElement } from "react";
import { View, type ViewProps } from "react-native";
import { ScreenProvider, useScreenContext } from "./screen.context";
import { screenVariants } from "./screen.variants";

export type ScreenRootProps = ViewProps & {
	/**
	 * Paint the screen's layout layers in debug colours — the footer's bands, a
	 * scrollable's spacers, a chat list's composer clearance.
	 *
	 * Opt-in per screen and not gated behind `__DEV__`, so a layout can still be
	 * inspected on a release build where a reserve only goes wrong.
	 */
	debug?: boolean;
	className?: string;
};

/**
 * The root box of a screen, and the provider its parts measure themselves into.
 *
 * Lives in its own module rather than in `screen.tsx` because `Screen.Loading`
 * and `Screen.Error` are whole screens — they render this — and importing
 * `./screen` from either would close a cycle through the `Object.assign` that
 * names them. See AGENTS.md rule 3.
 */
export function ScreenRoot({ debug = false, className, children, ...props }: ScreenRootProps): ReactElement {
	// A nested screen keeps reporting to the outer one rather than starting a
	// second, unread set of measurements.
	const parentContext = useScreenContext();

	return (
		<ScreenProvider debug={debug} parentContext={parentContext}>
			<View className={screenVariants().root({ className })} {...props}>
				{children}
			</View>
		</ScreenProvider>
	);
}
