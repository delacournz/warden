import { Children, isValidElement, type ReactElement, type ReactNode, useMemo } from "react";
import { View, type ViewProps } from "react-native";
import type { PressableFeedback } from "@/components/ui/pressable/pressable.variants";
import { Separator } from "@/components/ui/separator";
import {
	type ButtonGroupContextValue,
	type ButtonGroupItemContextValue,
	ButtonGroupItemProvider,
	ButtonGroupProvider,
} from "./button.context";
import {
	type ButtonGroupOrientation,
	type ButtonSize,
	type ButtonVariant,
	buttonVariants,
	resolveGroupPositions,
	resolveGroupSeams,
} from "./button.variants";
import { ButtonGroupSeparator } from "./button-group-separator";
import { ButtonGroupText } from "./button-group-text";

export type ButtonGroupProps = ViewProps & {
	/** Which way the group runs. Members square the corners crossing the run. */
	orientation?: ButtonGroupOrientation;
	/** Shared by every member — controls of different heights do not join. */
	size?: ButtonSize;
	/** A default every member takes unless it names its own. */
	variant?: ButtonVariant;
	/** Disables every member that does not say otherwise. */
	isDisabled?: boolean;
	/** Press treatment for every member. Unset, a joined member fades rather than scaling. */
	feedback?: PressableFeedback;
	className?: string;
	children?: ReactNode;
};

function ButtonGroupRoot({
	orientation = "horizontal",
	size = "md",
	variant,
	isDisabled,
	feedback,
	className,
	children,
	...props
}: ButtonGroupProps): ReactElement {
	const group = useMemo<ButtonGroupContextValue>(
		() => ({ feedback, isDisabled, orientation, size, variant }),
		[feedback, isDisabled, orientation, size, variant]
	);

	const items = useMemo(() => Children.toArray(children), [children]);

	// One memo for the whole array rather than a hook per child, which a `.map()`
	// cannot have. A member's value is a new object only when the group's axes or
	// the members' order actually change.
	const values = useMemo(() => {
		const isMember = items.map(isGroupMember);
		const positions = resolveGroupPositions(isMember);
		const seams = resolveGroupSeams(isMember);

		return positions.map<ButtonGroupItemContextValue | null>((position, index) =>
			position === null ? null : { ...group, isSeamed: seams[index] === true, position }
		);
	}, [items, group]);

	return (
		<ButtonGroupProvider value={group}>
			<View className={buttonVariants({ orientation }).group({ className })} {...props}>
				{items.map((child, index) => {
					const value = values[index];
					if (!value) return child;
					return (
						<ButtonGroupItemProvider key={keyOf(child, index)} value={value}>
							{child}
						</ButtonGroupItemProvider>
					);
				})}
			</View>
		</ButtonGroupProvider>
	);
}

/**
 * Whether a child takes a position in the group.
 *
 * A deny-list rather than a check for `Button`, for two reasons. It lets any
 * control join a group and style itself from `useButtonGroupItem()` — the whole
 * point of the library's `useX()` hooks — and it means this file never imports
 * its own root for an identity check, which would close a cycle (AGENTS.md rule
 * 3).
 *
 * A hand-placed `Separator` is excluded alongside the group's own, the same
 * tolerance `ListGroup` extends to one.
 */
function isGroupMember(child: ReactNode): boolean {
	return isValidElement(child) && child.type !== ButtonGroupSeparator && child.type !== Separator;
}

/**
 * A stable key for a wrapped child.
 *
 * `Children.toArray` has already assigned every child a key, so the wrapper
 * reuses it rather than minting an index-based one — a group whose members are
 * reordered or conditionally rendered would otherwise remount them.
 */
function keyOf(child: ReactNode, index: number): string {
	return isValidElement(child) && child.key !== null ? child.key : `member-${index}`;
}

/**
 * Several controls joined into one run, sharing a corner and a seam.
 *
 * The group owns the axes because it owns the shape: `size` outright, since
 * controls of different heights do not join, and `variant`, `isDisabled` and
 * `feedback` as defaults a member may still override. Those three are published
 * raw, so `undefined` means "the group said nothing" and one member can disable
 * itself inside a group that did not.
 *
 * Each member is wrapped in a context provider carrying its place in the run.
 * That indirection is forced: React Native has no sibling selector, so the CSS
 * shadcn/ui uses on the web — `[&>[data-slot]~[data-slot]]:rounded-l-none` —
 * has no counterpart here and position has to be computed in JavaScript. A
 * provider is not a host component, so nothing is added to the layout.
 *
 * A member squares the corners crossing each seam and overlaps its neighbour by
 * a point, so two adjacent borders draw as one hairline. A group of one is
 * indistinguishable from the control on its own.
 *
 * The group paints nothing itself — no background, no border, no disabled fade.
 * A fade here would compound with the members' own down to a quarter opacity.
 *
 * Horizontal groups are content-width. For a run that fills its parent, put
 * `className="w-full"` on the group and `className="flex-1"` on each member.
 *
 * @example
 * <Button.Group variant="outline">
 *   <Button onPress={archive}>Archive</Button>
 *   <Button onPress={report}>Report</Button>
 *   <Button onPress={snooze}>Snooze</Button>
 * </Button.Group>
 *
 * @example
 * <Button.Group>
 *   <Button onPress={save}>Save</Button>
 *   <Button.Group.Separator />
 *   <Button accessibilityLabel="More" size="icon-md" onPress={openMenu}>
 *     <Icon icon={IconChevronDown} />
 *   </Button>
 * </Button.Group>
 */
export const ButtonGroup = Object.assign(ButtonGroupRoot, {
	/** A rule between two members. Takes no position, so the ends stay rounded. */
	Separator: ButtonGroupSeparator,
	/** A chunk that says something rather than doing something, joined like any member. */
	Text: ButtonGroupText,
	displayName: "DelacourUI.Button.Group",
});
