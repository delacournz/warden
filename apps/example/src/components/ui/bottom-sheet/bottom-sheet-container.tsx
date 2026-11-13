import {
	BottomSheet as Headless,
	type BottomSheetContainerProps as HeadlessProps,
} from "@delacour/react-native-bottom-sheet";
import { Children, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { withUniwind } from "uniwind";
import { cn } from "@/lib/cn";
import { BottomSheetBackground } from "./bottom-sheet-background";
import { BottomSheetHandle } from "./bottom-sheet-handle";

/**
 * The engine's panel, taught `className`.
 *
 * `withUniwind`'s return type maps over a component's props and loses the
 * shape of anything animated, so the signature is restated. Built at module
 * scope: in render it would mint a new component type every pass and remount
 * the whole sheet.
 */
type StyledContainerComponent = (props: HeadlessProps & { className?: string }) => ReactElement | null;

const StyledContainer = withUniwind(Headless.Container) as unknown as StyledContainerComponent;

export type BottomSheetContainerProps = HeadlessProps & {
	className?: string;
	/** Classes for the sheet's surface — the box behind the handle and the content. */
	backgroundClassName?: string;
	/** Classes for the row the grabber sits in. */
	handleClassName?: string;
	/** Classes for the grabber itself. */
	handleIndicatorClassName?: string;
};

/**
 * Whether the children hold one of the two parts the container would
 * otherwise write itself.
 *
 * `Children.toArray` does not open fragments, so this walks into them: a
 * `<>{showHandle && <BottomSheet.Handle />}</>` must count, or the sheet gets
 * a second handle and a second adjustable element for screen readers.
 */
export function hasSurfaceParts(children: ReactNode): boolean {
	return Children.toArray(children).some((child) => {
		if (!isValidElement<{ children?: ReactNode }>(child)) return false;
		if (child.type === Fragment) return hasSurfaceParts(child.props.children);
		return child.type === BottomSheetBackground || child.type === BottomSheetHandle;
	});
}

/**
 * The panel — the surface that moves.
 *
 * The engine positions it, sizes it to the frame and translates it by the
 * sheet's geometry; this adds classes and the two parts every sheet has.
 *
 * **It writes `Background` and `Handle` for you** when the children hold
 * neither (directly or inside a fragment), so the common sheet is `Container > Content` and nothing else. Write
 * either one yourself and it writes nothing — a container with a custom handle
 * and no surface is a decision, not an omission. The three `*ClassName` props
 * reach the parts it writes; a part you write takes its own `className`.
 *
 * **Sizing and behaviour live on the root, not here.** `snapPoints`,
 * `dynamicSizing`, `maxDynamicContentSize`, `keyboardBehavior` and the rest
 * are `BottomSheet`'s props: the engine resolves them once for every part, and
 * a panel that carried them would be a second place to look.
 *
 * @example
 * <BottomSheet.Container>
 *   <BottomSheet.Content>{…}</BottomSheet.Content>
 * </BottomSheet.Container>
 *
 * @example
 * // A custom grabber; the surface still comes with it.
 * <BottomSheet.Container backgroundClassName="bg-card">
 *   <BottomSheet.Background className="bg-card" />
 *   <BottomSheet.Handle><MyGrabber /></BottomSheet.Handle>
 *   <BottomSheet.Content>{…}</BottomSheet.Content>
 * </BottomSheet.Container>
 */
export function BottomSheetContainer({
	backgroundClassName,
	children,
	className,
	handleClassName,
	handleIndicatorClassName,
	...props
}: BottomSheetContainerProps): ReactElement {
	const surface = hasSurfaceParts(children) ? null : (
		<>
			<BottomSheetBackground className={backgroundClassName} />
			<BottomSheetHandle className={handleClassName} indicatorClassName={handleIndicatorClassName} />
		</>
	);

	return (
		<StyledContainer className={cn(className)} {...props}>
			{surface}
			{children}
		</StyledContainer>
	);
}
BottomSheetContainer.displayName = "DelacourUI.BottomSheet.Container";
