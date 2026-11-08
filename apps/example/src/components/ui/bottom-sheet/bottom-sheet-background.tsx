import {
	BottomSheet as Headless,
	type BottomSheetBackgroundProps as HeadlessProps,
	useBottomSheetInternal,
} from "@delacour/react-native-bottom-sheet";
import type { ReactElement } from "react";
import { withUniwind } from "uniwind";
import { bottomSheetVariants } from "./bottom-sheet.variants";

type StyledBackgroundComponent = (props: HeadlessProps & { className?: string }) => ReactElement | null;

// Third-party to Uniwind, so `className` needs the wrapper — and it has to be
// built at module scope or every render mints a new component type.
const StyledBackground = withUniwind(Headless.Background) as unknown as StyledBackgroundComponent;

export type BottomSheetBackgroundProps = HeadlessProps & {
	className?: string;
};

/**
 * The sheet's surface: the box behind the handle and the content.
 *
 * `bg-popover`, top corners rounded — and every corner when the root is
 * `detached`, because a floating card has a bottom edge on screen. The engine
 * sizes it: an attached surface fills the panel and its bottom edge is always
 * off-screen; a detached one is exactly the sheet's height, so the corners this
 * rounds are the ones you see.
 *
 * `Container` writes one for you unless you write it — see there.
 *
 * @example
 * <BottomSheet.Background className="bg-card" />
 */
export function BottomSheetBackground({ className, ...props }: BottomSheetBackgroundProps): ReactElement {
	const { detached } = useBottomSheetInternal();

	return (
		<StyledBackground
			className={bottomSheetVariants({ detached: detached !== null }).background({ className })}
			{...props}
		/>
	);
}
BottomSheetBackground.displayName = "DelacourUI.BottomSheet.Background";
