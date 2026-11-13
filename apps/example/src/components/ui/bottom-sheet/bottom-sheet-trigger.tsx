import { BottomSheet as Headless } from "@delacour/react-native-bottom-sheet";
import type { ReactElement } from "react";
import { Slot } from "@/lib/slot";
import { Pressable, type PressableProps } from "@/components/ui/pressable";

export type BottomSheetTriggerProps = PressableProps;

/**
 * The control that opens the sheet.
 *
 * On its own it is this library's `Pressable`, so `feedback`, `haptic` and the
 * rest are inherited rather than restated. It opens through the same state a
 * controlled `isOpen` drives, and a caller's own `onPress` still runs after
 * the open.
 *
 * **`asChild` donates the press rather than wrapping the child**, which is
 * where it differs from `Pressable`'s own. Two tap gestures in an
 * ancestor/descendant pair are not simultaneous: Gesture Handler gives the
 * press to the DESCENDANT, so a `Button` wrapped in a pressable trigger would
 * win the touch, fire the `onPress` it does not have, and the sheet would never
 * open. The engine's `Trigger asChild` hands `onPress` down as a prop instead,
 * chained ahead of any the child already had — the child keeps its own
 * gesture, feedback and haptic, and there is no extra view in the tree. The
 * remaining props reach the child through this library's `Slot`, one layer in.
 *
 * The corollary: **the child has to be something that handles `onPress`.** A
 * `View` or a `Text` takes the prop and ignores it. Wrap a `Button`, a
 * `ListGroup.Item`, or anything else built on `Pressable`.
 *
 * @example
 * <BottomSheet.Trigger asChild>
 *   <Button variant="secondary">Open</Button>
 * </BottomSheet.Trigger>
 *
 * @example
 * // No asChild: the trigger is its own pressable.
 * <BottomSheet.Trigger className="p-4">
 *   <Text>Open</Text>
 * </BottomSheet.Trigger>
 */
export function BottomSheetTrigger({
	asChild = false,
	children,
	onPress,
	...props
}: BottomSheetTriggerProps): ReactElement {
	const child = asChild ? <Slot {...props}>{children}</Slot> : <Pressable {...props}>{children}</Pressable>;

	return (
		<Headless.Trigger asChild onPress={onPress}>
			{child}
		</Headless.Trigger>
	);
}
BottomSheetTrigger.displayName = "DelacourUI.BottomSheet.Trigger";
