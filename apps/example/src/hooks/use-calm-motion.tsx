import { createContext, type ReactElement, type ReactNode, useContext } from "react";
import { useReducedMotion } from "react-native-reanimated";
import { calmMotion } from "@/lib/calm-motion";

const CalmMotionContext = createContext(false);

export type CalmMotionProviderProps = {
	/** Hold every decorative loop beneath this still, whatever the OS setting. */
	isMotionCalm: boolean;
	children: ReactNode;
};

/**
 * Asks every decorative loop beneath it to hold still — for an E2E build, whose test runner waits
 * for the screen to stop moving before each gesture. `DelacourProvider` mounts it from its own
 * `isMotionCalm`; mount it by hand only in an app that composes its providers itself.
 *
 * Optional: without one, {@link useCalmMotion} follows the OS reduce-motion setting alone.
 */
export function CalmMotionProvider({ isMotionCalm, children }: CalmMotionProviderProps): ReactElement {
	return <CalmMotionContext.Provider value={isMotionCalm}>{children}</CalmMotionContext.Provider>;
}

/**
 * Whether decorative motion should hold still, for this device and this app: the one place a
 * component asks whether to loop. See `calmMotion` for what counts as decorative.
 */
export function useCalmMotion(): boolean {
	return calmMotion({ isMotionCalm: useContext(CalmMotionContext), isReduceMotion: useReducedMotion() });
}
CalmMotionProvider.displayName = "DelacourUI.CalmMotionProvider";
