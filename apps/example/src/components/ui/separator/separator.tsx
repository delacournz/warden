import type { ReactElement } from "react";
import { View, type ViewProps } from "react-native";
import type { VariantProps } from "tailwind-variants";
import { tv } from "@/lib/tv";

export const SEPARATOR_ORIENTATIONS = ["horizontal", "vertical"] as const;

export type SeparatorOrientation = (typeof SEPARATOR_ORIENTATIONS)[number];

/**
 * Styling for a separator.
 *
 * The line is a filled box rather than a border, so a caller can inset it with
 * a plain `mx-*` / `my-*` without fighting a border's own box model — which is
 * how `ListGroup` positions the dividers it inserts between its rows.
 *
 * The long axis is `self-stretch`, never `w-full` / `h-full`. Yoga resolves a
 * percentage length against the parent's content box and then adds the margins
 * on top, so an inset `w-full` line starts 16pt in and runs 16pt past the far
 * edge — a gap down one side and none down the other. Stretching subtracts the
 * margins instead, which is what an inset divider actually needs.
 *
 * The two orientations are exclusive: `horizontal` draws `h-px` and no `w-px`,
 * `vertical` the reverse, so the hairline is only ever on one axis.
 *
 * Declared here rather than in a `*.variants.ts` sibling because a separator is
 * a single styled element with no compound parts and no pure resolvers — there
 * is no slot set for another file to share. The cost is that `bun test` cannot
 * reach it: this module imports React Native, whose Flow-typed source Bun's
 * transpiler cannot parse. See AGENTS.md.
 */
export const separatorVariants = tv({
	base: "self-stretch bg-border",
	variants: {
		orientation: {
			horizontal: "h-px",
			vertical: "w-px",
		},
	},
	defaultVariants: {
		orientation: "horizontal",
	},
});

export type SeparatorVariantProps = VariantProps<typeof separatorVariants>;

export type SeparatorProps = ViewProps & {
	/** Axis the line runs along. A vertical separator needs a parent with a height. */
	orientation?: SeparatorOrientation;
	className?: string;
};

/**
 * A one-pixel rule dividing content.
 *
 * Hidden from assistive technology: the line carries no information a screen
 * reader can use, and announcing one between every row of a list would bury the
 * rows themselves.
 *
 * `ListGroup` inserts these between its rows automatically, so this is written
 * out by hand only for a divider elsewhere — or to place one inside a
 * `ListGroup` deliberately, which suppresses the automatic one at that point.
 *
 * @example
 * <Separator className="my-4" />
 *
 * @example
 * <View className="flex-row items-center gap-3">
 *   <Text>Left</Text>
 *   <Separator className="h-4" orientation="vertical" />
 *   <Text>Right</Text>
 * </View>
 */
export function Separator({ orientation = "horizontal", className, ...props }: SeparatorProps): ReactElement {
	return (
		<View
			accessibilityElementsHidden
			accessible={false}
			className={separatorVariants({ className, orientation })}
			importantForAccessibility="no-hide-descendants"
			{...props}
		/>
	);
}
Separator.displayName = "DelacourUI.Separator";
