import { type ReactElement, useState } from "react";
import { type AccessibilityActionEvent, AccessibilityInfo, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { IconBell, IconStar } from "@/lib/icons/central";

const SLIDER_MIN = 0;
const SLIDER_MAX = 10;
const ADJUST_ACTIONS = [{ name: "increment" }, { name: "decrement" }] as const;
const ROW_ACTIONS = [
	{ name: "archive", label: "Archive" },
	{ name: "delete", label: "Delete" },
] as const;

/**
 * Labelled controls a screen reader walks through: a switch, an adjustable (increment / decrement actions, value
 * 0-10), an image with a label next to a decorative one hidden from readers, a button with a hint, and a row with
 * custom actions. Every part carries `accessible` so its testID reaches the accessibility tree.
 */
export function ControlsSection(): ReactElement {
	const [enabled, setEnabled] = useState(false);
	const [level, setLevel] = useState(5);
	const [lastAction, setLastAction] = useState("none");

	const adjust = (event: AccessibilityActionEvent) => {
		const delta = event.nativeEvent.actionName === "increment" ? 1 : -1;
		setLevel((value) => Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, value + delta)));
	};

	const rowAction = (event: AccessibilityActionEvent) => setLastAction(event.nativeEvent.actionName);

	return (
		<Card>
			<Card.Header>
				<Card.Title accessibilityRole="header" testID="a11y-heading">
					Controls
				</Card.Title>
			</Card.Header>
			<Card.Content className="gap-4">
				<Switch
					accessibilityLabel="Sync over cellular"
					isSelected={enabled}
					onSelectedChange={setEnabled}
					testID="a11y-switch"
				/>
				<View
					accessibilityActions={ADJUST_ACTIONS}
					accessibilityLabel="Volume"
					accessibilityRole="adjustable"
					accessibilityValue={{ min: SLIDER_MIN, max: SLIDER_MAX, now: level }}
					accessible
					className="min-h-12 justify-center rounded-lg bg-surface px-3"
					onAccessibilityAction={adjust}
					testID="a11y-slider"
				>
					<Text.Label>Volume</Text.Label>
					<View className="mt-1 h-1.5 rounded-full bg-secondary">
						<View className="h-1.5 rounded-full bg-primary" style={{ width: `${(level / SLIDER_MAX) * 100}%` }} />
					</View>
				</View>
				<View className="flex-row items-center gap-4">
					<View accessibilityLabel="Starred item" accessibilityRole="image" accessible testID="a11y-image">
						<Icon icon={IconStar} />
					</View>
					<View accessible={false} importantForAccessibility="no-hide-descendants" testID="a11y-decorative">
						<Icon icon={IconBell} />
					</View>
				</View>
				<Button
					accessibilityHint="Saves your changes to the cloud"
					onPress={() => AccessibilityInfo.announceForAccessibility("Saved")}
					size="lg"
					testID="a11y-hinted"
					variant="outline"
				>
					Save changes
				</Button>
				<View
					accessibilityActions={ROW_ACTIONS}
					accessibilityLabel="Quarterly report"
					accessible
					className="min-h-12 justify-center rounded-lg bg-surface px-3"
					onAccessibilityAction={rowAction}
					testID="a11y-row"
				>
					<Text.Label>Quarterly report</Text.Label>
				</View>
				<Text.Caption accessible testID="a11y-row-action">
					{`Last action: ${lastAction}`}
				</Text.Caption>
			</Card.Content>
		</Card>
	);
}
