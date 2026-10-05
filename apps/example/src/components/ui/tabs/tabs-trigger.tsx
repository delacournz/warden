import { Children, type ReactElement, type ReactNode, useCallback, useEffect, useMemo } from "react";
import type { LayoutChangeEvent } from "react-native";
import { type IconDefaults, IconDefaultsProvider } from "@/components/ui/icon";
import { Pressable, type PressableProps } from "@/components/ui/pressable";
import { TextClassProvider } from "@/components/ui/text/text.context";
import { resolveTextClass } from "@/components/ui/text/text.variants";
import {
	type TabsTriggerContextValue,
	TabsTriggerProvider,
	useTabsIsScrollable,
	useTabsListPart,
	useTabsPart,
} from "./tabs.context";
import { resolveTabsTriggerState, TABS_FOREGROUND_TOKEN, TABS_LABEL_TEXT_SIZE, tabsVariants } from "./tabs.variants";
import { TabsLabel } from "./tabs-label";

export type TabsTriggerRenderProps = {
	/** What this trigger is called. */
	value: string;
	/** Whether this trigger is the settled selection. */
	isSelected: boolean;
	/** Whether this trigger is unavailable. */
	isDisabled: boolean;
};

export type TabsTriggerProps = Omit<PressableProps, "asChild" | "busy" | "children" | "disabled"> & {
	/** Identifies this trigger, and the `Tabs.Content` it selects. Required. */
	value: string;
	/** Wins over the enclosing `Tabs`. `false` opts one trigger out of a disabled bar. */
	isDisabled?: boolean;
	/**
	 * Nodes, or a function called with this trigger's settled state.
	 *
	 * The render prop is the escape hatch for anything a class cannot express — a
	 * count that only shows while selected, a glyph that swaps. Bare strings are
	 * wrapped in a `Tabs.Label` automatically.
	 */
	children?: ReactNode | ((props: TabsTriggerRenderProps) => ReactNode);
};

/**
 * One tab, and the surface its press is claimed on.
 *
 * **Its `onLayout` is the indicator's geometry.** The frame it reports — an `x`
 * and a width in the row's own space — is what the capsule interpolates over, so
 * there is no table of tab widths anywhere and none could be right: a trigger's
 * width is its label's, which depends on the string and on the OS font scale.
 * That is also half the reason there is no `asChild` here; the other half is that
 * `Pressable`'s own `useAnimatedStyle` already writes `opacity` and `transform`
 * on the node a donated element would become, and two animated styles on one node
 * fight for the same props.
 *
 * **Two defaults differ from a bare `Pressable` and only two.** `feedback` is
 * `fade`, because a wide flat trigger that scales reads as the whole track
 * flexing rather than as one tab responding — `ListGroup.Item`'s reason. `haptic`
 * is `selection`, because a tab change is a selection change. Both are ordinary
 * props, so `haptic={false}` silences it.
 *
 * **`onPress` is forwarded, not swallowed.** The press selects and then the
 * caller's handler runs, so a re-press of the already-active tab still reaches
 * them — which is where a scroll-to-top goes. `shouldEmitTabChange` is what keeps
 * `onValueChange` quiet for it.
 *
 * Icons are composed, never passed as props: the trigger wraps its subtree in an
 * `IconDefaultsProvider` carrying the bar's own glyph step and its variant's
 * foreground, beside a `TextClassProvider` carrying the resolved label treatment.
 * A bare `<Icon>` or `<Text>` inside a trigger therefore needs nothing said at the
 * call site.
 */
export function TabsTrigger({
	value,
	isDisabled,
	children,
	className,
	feedback = "fade",
	haptic = "selection",
	onPress,
	onLayout,
	...props
}: TabsTriggerProps): ReactElement {
	const bar = useTabsPart("Tabs.Trigger");
	const { measure, unmeasure } = useTabsListPart("Tabs.Trigger");
	const isScrollable = useTabsIsScrollable();

	const { isDisabled: settledIsDisabled } = resolveTabsTriggerState({ own: isDisabled, root: bar.isDisabled });
	const isSelected = bar.value === value;
	const isVisuallySelected = bar.order[bar.visualIndex] === value;
	const index = bar.order.indexOf(value);

	const { registerValue } = bar;
	useEffect(() => registerValue(value), [registerValue, value]);

	useEffect(() => () => unmeasure(value), [unmeasure, value]);

	const handleLayout = useCallback(
		(event: LayoutChangeEvent) => {
			// The caller's runs first and always, the way `Screen.Navbar` forwards its
			// own — a component that measured itself and swallowed the event would
			// take a prop away that has nothing to do with the measurement.
			onLayout?.(event);
			measure(value, { width: event.nativeEvent.layout.width, x: event.nativeEvent.layout.x });
		},
		[measure, onLayout, value]
	);

	const handlePress = useCallback(() => {
		bar.select(value);
		onPress?.();
	}, [bar, onPress, value]);

	const context = useMemo<TabsTriggerContextValue>(
		() => ({ index, isDisabled: settledIsDisabled, isSelected, isVisuallySelected, value }),
		[index, settledIsDisabled, isSelected, isVisuallySelected, value]
	);

	const slots = tabsVariants({
		isDisabled: settledIsDisabled,
		isScrollable,
		size: bar.size,
		variant: bar.variant,
	});

	const iconClassName = slots.icon();
	const iconDefaults = useMemo<IconDefaults>(
		() => ({
			className: iconClassName,
			color: isVisuallySelected
				? TABS_FOREGROUND_TOKEN[bar.variant].selected
				: TABS_FOREGROUND_TOKEN[bar.variant].unselected,
		}),
		[bar.variant, iconClassName, isVisuallySelected]
	);

	// One treatment covers the whole subtree — a tab has a label and no description
	// part — which is the condition for publishing into the cascade.
	//
	// It carries no colour, because the `label` slot no longer names one: the
	// label's colour fades, and a class here would be a second source for it. A
	// bare `<Text>` composed into a trigger therefore takes the page colour; reach
	// for `Tabs.Label` when it should read as part of the tab.
	const labelClassName = slots.label();
	const labelClass = useMemo(
		() => resolveTextClass({ className: labelClassName, size: TABS_LABEL_TEXT_SIZE[bar.size], variant: "label" }),
		[bar.size, labelClassName]
	);

	const content = useMemo(() => {
		if (typeof children === "function") {
			return children({ isDisabled: settledIsDisabled, isSelected, value });
		}
		return wrapTextChildren(children);
	}, [children, settledIsDisabled, isSelected, value]);

	return (
		<TabsTriggerProvider value={context}>
			<Pressable
				accessibilityRole="tab"
				accessibilityState={{ disabled: settledIsDisabled, selected: isSelected }}
				className={slots.trigger({ className })}
				disabled={settledIsDisabled}
				feedback={feedback}
				haptic={haptic}
				onLayout={handleLayout}
				onPress={handlePress}
				{...props}
			>
				<IconDefaultsProvider value={iconDefaults}>
					<TextClassProvider value={labelClass}>{content}</TextClassProvider>
				</IconDefaultsProvider>
			</Pressable>
		</TabsTriggerProvider>
	);
}
TabsTrigger.displayName = "DelacourUI.Tabs.Trigger";

/**
 * Wraps bare text in a `Tabs.Label`.
 *
 * React Native cannot render a string outside a `<Text>`, so `<Tabs.Trigger
 * value="a">All</Tabs.Trigger>` would otherwise crash. Consecutive strings and
 * numbers collapse into one label rather than one each — `Tab {n}` is a single
 * piece of text, and wrapping the parts separately would space them apart by the
 * trigger's own gap.
 *
 * Lives here rather than with the label: it is the trigger that wraps its own
 * children, and importing it from the part would close a cycle. See AGENTS.md.
 */
function wrapTextChildren(children: ReactNode): ReactNode {
	const items = Children.toArray(children);
	const output: ReactNode[] = [];
	let run: (string | number)[] = [];

	const flushRun = () => {
		if (run.length === 0) return;
		output.push(<TabsLabel key={`label-${output.length}`}>{run.join("")}</TabsLabel>);
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
