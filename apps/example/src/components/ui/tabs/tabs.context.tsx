import { createContext, type ReactElement, type ReactNode, use } from "react";
import type { GestureType } from "react-native-gesture-handler";
import type { SharedValue } from "react-native-reanimated";
import type { TabMeasurement, TabsSize, TabsVariant, TabTracks } from "./tabs.variants";

export type TabsContextValue = {
	/** The selected tab's value. `null` is "nothing selected", never `undefined`. */
	value: string | null;
	/** What a trigger calls on press. Stays quiet when the tab is already selected. */
	select: (value: string) => void;
	/** Every tab's value, in the order its panels are laid out. */
	order: readonly string[];
	/**
	 * Which tab is painted as current — the one the indicator mostly covers.
	 *
	 * Distinct from {@link TabsContextValue.value}, and both are needed. The value
	 * is what a screen reader announces, what a panel hides on and what
	 * `onValueChange` reported; this is only what things are painted from, and it
	 * swaps mid-drag so a filled capsule never carries an unselected label.
	 */
	visualIndex: number;
	/** How the bar is painted. The root owns this axis outright. */
	variant: TabsVariant;
	/** The bar's size. The root owns this axis outright. */
	size: TabsSize;
	/** Whether a pan on the panels drags them. */
	isSwipeable: boolean;
	/**
	 * Raw rather than resolved, and deliberately so — `Radio.Group`'s note, and the
	 * same reason. The root paints nothing whose state it has to settle, so leaving
	 * `undefined` to mean "the bar said nothing" is what lets one trigger disable
	 * itself.
	 */
	isDisabled?: boolean;
	/** Records a trigger's value, for a bar with no panels to take its order from. */
	registerValue: (value: string) => () => void;
};

export type TabsMotionValue = {
	/**
	 * Where the pager sits, in tab-index space, on the **UI thread**.
	 *
	 * `1.4` is 40% of the way from the second tab to the third. Every animated
	 * style in the component reads this one value — the pager's translation, the
	 * indicator's frame, each separator's opacity — so none of them can drift out
	 * of step by a frame.
	 */
	position: SharedValue<number>;
	/** The pager viewport's width in points, `0` before its first layout. */
	pageWidth: SharedValue<number>;
	/**
	 * The pager's own pan, published so a caller can relate their own to it.
	 *
	 * A horizontal scrollable *inside* a panel is a head-on conflict that only the
	 * caller can settle, because only they know which should win:
	 * `Gesture.Native().blocksExternalGesture(panGesture)` hands the touch to
	 * theirs. A hook rather than a prop, the trade `useScreenFooterKeyboardClearance`
	 * already makes.
	 */
	panGesture: GestureType;
};

export type TabsListValue = {
	/**
	 * The interpolation tracks, or `null` while any trigger is still unmeasured.
	 *
	 * One shared value holding three pre-built arrays rather than three shared
	 * values holding one each: `interpolate` throws when its input and output
	 * ranges differ in length, and three separate writes would be three separate
	 * chances for the UI thread to read a half-updated set.
	 */
	tracks: SharedValue<TabTracks | null>;
	/** A trigger reports its frame here on layout. Stable for the bar's lifetime. */
	measure: (value: string, measurement: TabMeasurement) => void;
	/** A trigger withdraws its frame here on unmount. Stable for the bar's lifetime. */
	unmeasure: (value: string) => void;
	/** The bar's own scroll offset, and the two widths `resolveScrollOffset` needs. */
	scrollX: SharedValue<number>;
	viewportWidth: SharedValue<number>;
	contentWidth: SharedValue<number>;
	/**
	 * Whether the bar is being scrolled by hand.
	 *
	 * Auto-scrolling into a hand-scroll — or into the momentum left behind by one —
	 * is a tug-of-war the user feels as the bar snapping backwards mid-flick.
	 */
	isBarDragging: SharedValue<boolean>;
};

export type TabsTriggerContextValue = {
	/** What this trigger is called, and the `Tabs.Content` it selects. */
	value: string;
	/** This trigger's place in the order, or `-1` when no panel claims its value. */
	index: number;
	/** Whether this trigger is the settled selection — what accessibility reads. */
	isSelected: boolean;
	/** Whether this trigger is the one currently painted as selected. */
	isVisuallySelected: boolean;
	/** Whether this trigger is unavailable, already settled from the bar and its own prop. */
	isDisabled: boolean;
};

const TabsContext = createContext<TabsContextValue | null>(null);
const TabsMotionContext = createContext<TabsMotionValue | null>(null);
const TabsListContext = createContext<TabsListValue | null>(null);
const TabsTriggerContext = createContext<TabsTriggerContextValue | null>(null);
const TabsScrollableContext = createContext(false);

/**
 * Supplies the bar's selection and axes to everything inside it.
 *
 * Lives in its own module, importing nothing but React and types, so a part can
 * read it without importing `./tabs`. That import would close a cycle, and Metro
 * serves a partially initialised module for a cycle — leaving the context
 * `undefined` at import time and red-boxing the app on a cold start.
 */
export function TabsProvider({ value, children }: { value: TabsContextValue; children: ReactNode }): ReactElement {
	return <TabsContext value={value}>{children}</TabsContext>;
}
TabsProvider.displayName = "DelacourUI.Tabs.Provider";

/**
 * Supplies the Reanimated layer.
 *
 * Split from {@link TabsProvider} because that one changes identity on every
 * selection, and `Tabs.Indicator` — whose whole job is to read the UI thread —
 * must never re-render for one. Every field here is a shared value or a gesture
 * built once, so this bundle is memoised once and never invalidated.
 */
export function TabsMotionProvider({ value, children }: { value: TabsMotionValue; children: ReactNode }): ReactElement {
	return <TabsMotionContext value={value}>{children}</TabsMotionContext>;
}
TabsMotionProvider.displayName = "DelacourUI.Tabs.MotionProvider";

/**
 * Supplies the trigger measurements a `Tabs.List` collects.
 *
 * Created by the list rather than by the root, so `Tabs.Indicator` and
 * `Tabs.Trigger` throw by name when either is written outside one — which is the
 * only way an indicator with nothing to measure could otherwise present itself.
 */
export function TabsListProvider({ value, children }: { value: TabsListValue; children: ReactNode }): ReactElement {
	return <TabsListContext value={value}>{children}</TabsListContext>;
}
TabsListProvider.displayName = "DelacourUI.Tabs.List.Provider";

/**
 * Supplies one trigger's settled state to its own parts.
 *
 * What the parts read is always the *resolved* state, so `Tabs.Label` never has
 * to know whether the bar is disabled, never runs the ladder, and never imports
 * the root.
 */
export function TabsTriggerProvider({
	value,
	children,
}: {
	value: TabsTriggerContextValue;
	children: ReactNode;
}): ReactElement {
	return <TabsTriggerContext value={value}>{children}</TabsTriggerContext>;
}
TabsTriggerProvider.displayName = "DelacourUI.Tabs.Trigger.Provider";

/**
 * Tells the triggers inside it that their row scrolls.
 *
 * A bare boolean rather than an object, so React compares it by value and an
 * unchanged one re-renders nothing — `TextClassProvider`'s argument. It answers
 * exactly one question: does a trigger fill the bar, or size to its own content.
 */
export function TabsScrollableProvider({ value, children }: { value: boolean; children: ReactNode }): ReactElement {
	return <TabsScrollableContext value={value}>{children}</TabsScrollableContext>;
}
TabsScrollableProvider.displayName = "DelacourUI.Tabs.ScrollView.Provider";

/** The enclosing bar's selection and axes, or null outside a `<Tabs>`. */
export function useTabsContext(): TabsContextValue | null {
	return use(TabsContext);
}

/**
 * Reads the enclosing bar's selection and axes.
 *
 * For a custom control that has to match the bar it sits in — a header showing
 * the active tab's title, a footer that changes with it. Throws outside a
 * `<Tabs>`; use {@link useTabsContext} where the bar is optional.
 */
export function useTabs(): TabsContextValue {
	const context = useTabsContext();
	if (!context) {
		throw new Error("useTabs must be called inside a <Tabs>.");
	}
	return context;
}

/** The enclosing bar's Reanimated layer, or null outside a `<Tabs>`. */
export function useTabsMotionContext(): TabsMotionValue | null {
	return use(TabsMotionContext);
}

/**
 * Reads the shared values the bar animates from, and its pan.
 *
 * For a custom part that has to move with the pager, and for relating a
 * horizontal gesture of your own to the pager's. Throws outside a `<Tabs>`.
 */
export function useTabsMotion(): TabsMotionValue {
	const context = useTabsMotionContext();
	if (!context) {
		throw new Error("useTabsMotion must be called inside a <Tabs>.");
	}
	return context;
}

/** The enclosing list's measurements, or null outside a `<Tabs.List>`. */
export function useTabsListContext(): TabsListValue | null {
	return use(TabsListContext);
}

/** Reads the enclosing list's trigger measurements. Throws outside a `<Tabs.List>`. */
export function useTabsList(): TabsListValue {
	const context = useTabsListContext();
	if (!context) {
		throw new Error("useTabsList must be called inside a <Tabs.List>.");
	}
	return context;
}

/** The enclosing trigger's settled state, or null outside a `<Tabs.Trigger>`. */
export function useTabsTriggerContext(): TabsTriggerContextValue | null {
	return use(TabsTriggerContext);
}

/**
 * Reads the enclosing trigger's settled state.
 *
 * Lets a custom child style itself to match without the trigger having to pass
 * props down through every slot. Throws outside a `<Tabs.Trigger>`.
 */
export function useTabsTrigger(): TabsTriggerContextValue {
	const context = useTabsTriggerContext();
	if (!context) {
		throw new Error("useTabsTrigger must be called inside a <Tabs.Trigger>.");
	}
	return context;
}

/** Whether the enclosing trigger row scrolls. `false` outside a `<Tabs.ScrollView>`. */
export function useTabsIsScrollable(): boolean {
	return use(TabsScrollableContext);
}

/**
 * The enclosing bar's state, for a compound part that cannot work without one.
 *
 * Internal: deliberately not re-exported from `index.ts`. A caller outside the
 * library wants {@link useTabs}, whose error message names the hook rather than a
 * part.
 */
export function useTabsPart(component: string): TabsContextValue {
	const context = useTabsContext();
	if (!context) {
		throw new Error(`${component} must be rendered inside a <Tabs>.`);
	}
	return context;
}

/** The enclosing bar's Reanimated layer, for a part that cannot work without one. Internal. */
export function useTabsMotionPart(component: string): TabsMotionValue {
	const context = useTabsMotionContext();
	if (!context) {
		throw new Error(`${component} must be rendered inside a <Tabs>.`);
	}
	return context;
}

/** The enclosing list's measurements, for a part that cannot work without one. Internal. */
export function useTabsListPart(component: string): TabsListValue {
	const context = useTabsListContext();
	if (!context) {
		throw new Error(`${component} must be rendered inside a <Tabs.List>.`);
	}
	return context;
}

/** The enclosing trigger's state, for a part that cannot work without one. Internal. */
export function useTabsTriggerPart(component: string): TabsTriggerContextValue {
	const context = useTabsTriggerContext();
	if (!context) {
		throw new Error(`${component} must be rendered inside a <Tabs.Trigger>.`);
	}
	return context;
}
