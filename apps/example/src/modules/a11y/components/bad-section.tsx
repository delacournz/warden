import type { ReactElement } from "react";
import { Pressable, View } from "react-native";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { IconBell, IconPlusSmall } from "@/lib/icons/central";

/**
 * Known accessibility failures, rendered only for `?bad=1`, so the audit has something to find: an icon button with no
 * accessible name (`missing-name`), a 20x20 target beside another target (`target-size`), a label that repeats its
 * role (`role-in-name`), and visible text that is not in the accessible name (`label-in-name`).
 */
export function BadSection(): ReactElement {
	return (
		<View className="gap-3" testID="a11y-bad">
			<Text.Label accessibilityRole="header">Known bad</Text.Label>
			<View className="flex-row items-center gap-px">
				<Pressable
					accessibilityRole="button"
					accessible
					className="h-11 w-11 items-center justify-center"
					testID="a11y-bad-unlabeled"
				>
					<Icon icon={IconBell} />
				</Pressable>
				<Pressable
					accessibilityLabel="Tiny"
					accessibilityRole="button"
					accessible
					className="h-5 w-5 items-center justify-center bg-surface"
					testID="a11y-bad-tiny"
				>
					<Icon icon={IconPlusSmall} size={12} />
				</Pressable>
			</View>
			<Pressable
				accessibilityLabel="Submit button"
				accessibilityRole="button"
				accessible
				className="h-12 justify-center rounded-lg bg-surface px-3"
				testID="a11y-bad-role"
			>
				<Text.Label>Send</Text.Label>
			</Pressable>
			<Pressable
				accessibilityLabel="Confirm"
				accessibilityRole="button"
				accessible
				className="h-12 justify-center rounded-lg bg-surface px-3"
				testID="a11y-bad-label"
			>
				<Text.Label>Buy now</Text.Label>
			</Pressable>
		</View>
	);
}
