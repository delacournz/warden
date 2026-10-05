import type { ReactElement } from "react";
import { Separator } from "@/components/ui/separator";
import { useButtonGroupPart } from "./button.context";
import { BUTTON_GROUP_SEPARATOR_ORIENTATION, buttonVariants } from "./button.variants";

export type ButtonGroupSeparatorProps = {
	className?: string;
};

/**
 * A rule between two members of a group.
 *
 * Runs across the group rather than along it — a line drawn along the run would
 * sit under the members instead of between them — so it reads the group's
 * orientation and inverts it. That inversion is a map in `button.variants.ts`
 * rather than a `SeparatorOrientation` here, because that type lives beside a
 * React Native import and the variants file has to stay parseable by `bun test`.
 *
 * A separator is deliberately **not** a member: it consumes no position, so the
 * buttons either side of one are still the group's first and last and keep their
 * rounded outer corners. It also suppresses the seam of the member after it — a
 * one-point rule under a one-point overlap would be an invisible rule.
 *
 * The line takes its length from this wrapper, since a `Separator` is
 * `self-stretch` on its long axis rather than a percentage of its parent.
 */
export function ButtonGroupSeparator({ className }: ButtonGroupSeparatorProps): ReactElement {
	const { orientation } = useButtonGroupPart("Button.Group.Separator");

	return (
		<Separator
			className={buttonVariants({ orientation }).groupSeparator({ className })}
			orientation={BUTTON_GROUP_SEPARATOR_ORIENTATION[orientation]}
		/>
	);
}
ButtonGroupSeparator.displayName = "DelacourUI.Button.Group.Separator";
