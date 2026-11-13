import {
	BottomSheet as Headless,
	type BottomSheetStepProps as HeadlessStepProps,
	type BottomSheetStepsProps as HeadlessStepsProps,
	type SheetEvent,
} from "@delacour/react-native-bottom-sheet";
import type { ReactElement } from "react";
import { withUniwind } from "uniwind";
import { BOTTOM_SHEET_FOOTER_GAP, bottomSheetVariants } from "./bottom-sheet.variants";

/** The class prop restated so `<S, C, E>` survive `withUniwind` — see `bottom-sheet-flat-list.tsx`. */
type StyledStepsComponent = <S extends string, C, E extends SheetEvent>(
	props: HeadlessStepsProps<S, C, E> & { className?: string }
) => ReactElement | null;

type StyledStepComponent = <S extends string>(
	props: HeadlessStepProps<S> & { className?: string }
) => ReactElement | null;

// Both built at module scope, or every render mints a new component type and
// the step stack remounts mid-transition.
const StyledSteps = withUniwind(Headless.Steps) as unknown as StyledStepsComponent;
const StyledStep = withUniwind(Headless.Step) as unknown as StyledStepComponent;

export type BottomSheetStepsProps<S extends string, C, E extends SheetEvent> = HeadlessStepsProps<S, C, E> & {
	className?: string;
};

export type BottomSheetStepProps<S extends string = string> = HeadlessStepProps<S> & {
	className?: string;
};

/**
 * A body whose contents follow a step machine and whose height glides between
 * them.
 *
 * The engine's `Steps` — `Content` with an animated-height stack inside — with
 * the library's gutter on the box around the stack. Only the gutter: the
 * engine measures each `Step`, not the box, so vertical padding here would be
 * height the sheet never counts. `Step` carries that instead.
 *
 * A `Footer` written beside it reads the same controller through
 * `useSheetStep()`, which is how a Next button outside the body knows what it
 * can send.
 *
 * @example
 * const machine = defineSheetMachine<Step, Context, Event>({ … });
 *
 * function Form() {
 *   const controller = useSheetMachine(machine);
 *   return (
 *     <BottomSheet.Steps controller={controller}>
 *       <BottomSheet.Step name="details">…</BottomSheet.Step>
 *       <BottomSheet.Step name="confirm">…</BottomSheet.Step>
 *     </BottomSheet.Steps>
 *   );
 * }
 */
export function BottomSheetSteps<S extends string, C, E extends SheetEvent>({
	className,
	footerGap = BOTTOM_SHEET_FOOTER_GAP,
	...props
}: BottomSheetStepsProps<S, C, E>): ReactElement {
	return <StyledSteps className={bottomSheetVariants().steps({ className })} footerGap={footerGap} {...props} />;
}
BottomSheetSteps.displayName = "DelacourUI.BottomSheet.Steps";

/**
 * One step of a `Steps` body — a key of the machine's `states`.
 *
 * Reads like `Content`: the same gap and top padding, less the gutter `Steps`
 * already carries. The engine positions it across the top of the stack,
 * measures it while it is current, and fades or slides it against its
 * neighbour.
 *
 * @example
 * <BottomSheet.Step name="details">
 *   <BottomSheet.Title>Your details</BottomSheet.Title>
 *   {fields}
 * </BottomSheet.Step>
 */
export function BottomSheetStep<S extends string = string>({
	className,
	...props
}: BottomSheetStepProps<S>): ReactElement {
	return <StyledStep className={bottomSheetVariants().step({ className })} {...props} />;
}
BottomSheetStep.displayName = "DelacourUI.BottomSheet.Step";
