import { Children, type ReactElement, type ReactNode, useCallback, useMemo } from "react";
import { type AccessibilityActionEvent, View } from "react-native";
import { useControllableState } from "@/hooks/use-controllable-state";
import { IconDefaultsProvider } from "@/components/ui/icon";
import { Pressable, type PressableProps } from "@/components/ui/pressable";
import { TextClassProvider } from "@/components/ui/text/text.context";
import { type ChipContextValue, ChipProvider } from "./chip.context";
import {
	CHIP_HIT_SLOP,
	type ChipColor,
	type ChipSize,
	type ChipVariant,
	chipVariants,
	resolveChipCloseExposure,
	resolveChipForegroundToken,
	resolveChipMode,
} from "./chip.variants";
import { ChipCloseButton } from "./chip-close-button";
import { ChipEndContent } from "./chip-end-content";
import { ChipLabel } from "./chip-label";
import { ChipStartContent } from "./chip-start-content";

export type ChipProps = Omit<PressableProps, "asChild" | "busy" | "children" | "disabled"> & {
	/** How the chip is painted while unselected. */
	variant?: ChipVariant;
	/** What the chip means. Also the fill it takes when selected. */
	color?: ChipColor;
	size?: ChipSize;
	/**
	 * Controlled selected state. Setting it — even to `false` — makes the chip a
	 * toggle, announced with its state; a tap reports the flip through
	 * `onSelectedChange`.
	 */
	isSelected?: boolean;
	/** Starting selected state while uncontrolled. Also makes the chip a toggle. */
	defaultSelected?: boolean;
	onSelectedChange?: (isSelected: boolean) => void;
	isDisabled?: boolean;
	/** Composes a trailing remove control in. Its press never toggles the chip or reaches `onPress`. */
	onClose?: () => void;
	/** Name a screen reader gives the remove control. Defaults to `Remove`. */
	closeAccessibilityLabel?: string;
	/** `testID` for the remove control, so a test or automation can press it. */
	closeTestID?: string;
	children?: ReactNode;
};

function ChipRoot({
	variant = "soft",
	color = "default",
	size = "md",
	isSelected,
	defaultSelected,
	onSelectedChange,
	isDisabled = false,
	onClose,
	closeAccessibilityLabel,
	closeTestID,
	onPress,
	onLongPress,
	haptic,
	feedback = "scale",
	pressedScale,
	pressedOpacity,
	accessibilityState,
	accessibilityActions,
	onAccessibilityAction,
	className,
	children,
	...props
}: ChipProps): ReactElement {
	const mode = resolveChipMode({ defaultSelected, isSelected, onLongPress, onPress, onSelectedChange });
	const closeExposure = resolveChipCloseExposure({ hasClose: onClose !== undefined, mode });

	const [ownSelected, setSelected] = useControllableState({
		defaultValue: defaultSelected ?? false,
		onChange: onSelectedChange,
		value: isSelected,
	});
	const selected = mode === "toggle" && ownSelected;

	const handlePress = useCallback(() => {
		if (mode === "toggle") setSelected(!selected);
		onPress?.();
	}, [mode, onPress, selected, setSelected]);

	const context = useMemo<ChipContextValue>(
		() => ({ color, isDisabled, isSelected: selected, size, variant }),
		[color, isDisabled, selected, size, variant]
	);

	const slots = chipVariants({ color, isDisabled, isSelected: selected, size, variant });

	// Icons composed into the chip adopt these unless told otherwise, and turn
	// with the label when the chip is selected.
	const iconClassName = slots.icon();
	const foregroundToken = resolveChipForegroundToken({ color, isSelected: selected, variant });
	const iconDefaults = useMemo(
		() => ({ className: iconClassName, color: foregroundToken }),
		[iconClassName, foregroundToken]
	);

	const content = useMemo(() => wrapTextChildren(children), [children]);
	const rootClassName = slots.root({ className });

	// Inside a pressable chip the close control is folded into the chip's own
	// accessibility element, so it is hidden there and offered as the `remove`
	// action below instead — see `resolveChipCloseExposure`.
	const closeHidden = closeExposure === "action";
	const inner = (
		<IconDefaultsProvider value={iconDefaults}>
			<TextClassProvider value={slots.label()}>
				{content}
				{onClose ? (
					<ChipCloseButton
						accessibilityElementsHidden={closeHidden}
						accessible={!closeHidden}
						accessibilityLabel={closeAccessibilityLabel}
						importantForAccessibility={closeHidden ? "no-hide-descendants" : "auto"}
						onPress={onClose}
						testID={closeTestID}
					/>
				) : null}
			</TextClassProvider>
		</IconDefaultsProvider>
	);

	const actions =
		closeExposure === "action"
			? [...(accessibilityActions ?? []), { label: closeAccessibilityLabel ?? "Remove", name: "remove" }]
			: accessibilityActions;

	const handleAccessibilityAction = (event: AccessibilityActionEvent) => {
		if (closeExposure === "action" && event.nativeEvent.actionName === "remove" && !isDisabled) {
			onClose?.();
			return;
		}
		onAccessibilityAction?.(event);
	};

	// A chip with nothing to do stays a plain box — see `resolveChipMode`.
	if (mode === "static") {
		return (
			<ChipProvider value={context}>
				<View
					accessibilityActions={accessibilityActions}
					className={rootClassName}
					onAccessibilityAction={onAccessibilityAction}
					{...props}
				>
					{inner}
				</View>
			</ChipProvider>
		);
	}

	// A toggle reports `selected`, which VoiceOver reads as "Selected" and
	// TalkBack as "selected" — the native idiom for a filter — and a plain
	// button reports nothing extra. Pressable merges `disabled` in on top.
	const state = mode === "toggle" ? { ...accessibilityState, selected } : accessibilityState;

	return (
		<ChipProvider value={context}>
			<Pressable
				accessibilityActions={actions}
				accessibilityRole="button"
				accessibilityState={state}
				className={rootClassName}
				disabled={isDisabled}
				feedback={feedback}
				haptic={haptic ?? (mode === "toggle" ? "selection" : false)}
				hitSlop={CHIP_HIT_SLOP[size]}
				onAccessibilityAction={handleAccessibilityAction}
				onLongPress={onLongPress}
				onPress={handlePress}
				pressedOpacity={pressedOpacity}
				pressedScale={pressedScale}
				{...props}
			>
				{inner}
			</Pressable>
		</ChipProvider>
	);
}

/**
 * Wraps bare text children in a `Chip.Label`.
 *
 * React Native cannot render a string outside a `<Text>`, so `<Chip>Design</Chip>`
 * would otherwise crash. Consecutive strings and numbers are collected into a
 * single label rather than one each — `{count} open` is one piece of text, and
 * wrapping the parts separately would space them apart by the chip's gap.
 */
function wrapTextChildren(children: ReactNode): ReactNode {
	const items = Children.toArray(children);
	const output: ReactNode[] = [];
	let run: (string | number)[] = [];

	const flushRun = () => {
		if (run.length === 0) return;
		output.push(<ChipLabel key={`label-${output.length}`}>{run.join("")}</ChipLabel>);
		run = [];
	};

	for (const child of items) {
		if (typeof child === "string" || typeof child === "number") {
			run.push(child);
			continue;
		}
		flushRun();
		output.push(child);
	}
	flushRun();

	return output;
}

/**
 * An interactive pill — a filter that is on or off, a tag, or a token that can
 * be removed.
 *
 * What it does is decided by the props it is given, never by a `type` flag:
 *
 * - **Nothing** — a tag. A plain `View`, not announced as a control.
 * - **`onPress` / `onLongPress`** — a button.
 * - **`isSelected`, `defaultSelected` or `onSelectedChange`** — a filter. A tap
 *   flips the state, a `selection` haptic ticks, and a screen reader hears
 *   whether it is selected. Controlled or uncontrolled, like `Checkbox`.
 * - **`onClose`** — adds a trailing remove control, a pressable of its own, so
 *   removing a chip never also toggles it. Combines with any of the above; on
 *   a pressable chip a screen reader reaches it as a `remove` action.
 *
 * Shares Badge's `color` and `size` axes and its tones: an unselected chip is
 * painted exactly as the badge of the same `variant` and `color`. Selection
 * replaces that with a solid fill in the chip's colour, and a selected
 * `default` chip inverts. The border is reserved in every state, so selecting a
 * chip never reflows the row it sits in.
 *
 * Icons are composed in, not passed as props. Anything in the subtree inherits
 * the chip's icon size and its current surface's colour, and follows it when
 * the chip is selected.
 *
 * @example
 * <Chip color="success">Shipped</Chip>
 *
 * @example
 * const [open, setOpen] = useState(false);
 * <Chip isSelected={open} onSelectedChange={setOpen}>
 *   <Icon icon={IconFilter} />
 *   <Chip.Label>Open only</Chip.Label>
 * </Chip>
 *
 * @example
 * <Chip onClose={() => remove(tag)} variant="outline">
 *   {tag}
 * </Chip>
 */
export const Chip = Object.assign(ChipRoot, {
	/** The chip's text. Picks its colour and type scale from the chip's variant, colour, size and selection. */
	Label: ChipLabel,
	/** A centred wrapper for leading content that is not an `Icon` — an avatar, a status dot. */
	StartContent: ChipStartContent,
	/** A centred wrapper for trailing content that is not an `Icon` — a count. */
	EndContent: ChipEndContent,
	/** The trailing remove control. Composed in automatically whenever `onClose` is set. */
	CloseButton: ChipCloseButton,
	displayName: "DelacourUI.Chip",
});
