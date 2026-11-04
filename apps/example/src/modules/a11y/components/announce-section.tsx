import { type ReactElement, useState } from "react";
import { AccessibilityInfo, Platform } from "react-native";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";

/**
 * A polite live-region counter with a button that bumps it, and a button that announces "Saved" on demand. Android
 * reads `accessibilityLiveRegion`; React Native on iOS has no live regions, so the bump posts the new count as an
 * announcement there, which is what a VoiceOver user needs to hear.
 */
export function AnnounceSection(): ReactElement {
	const [count, setCount] = useState(0);

	const increment = () => {
		const next = count + 1;
		setCount(next);
		if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(`Count: ${next}`);
	};

	return (
		<Card>
			<Card.Header>
				<Card.Title accessibilityRole="header">Announcements</Card.Title>
			</Card.Header>
			<Card.Content className="gap-3">
				<Text.Label accessibilityLiveRegion="polite" accessible testID="a11y-counter">
					{`Count: ${count}`}
				</Text.Label>
				<Button onPress={increment} size="lg" testID="a11y-increment" variant="outline">
					Increment
				</Button>
				<Button
					onPress={() => AccessibilityInfo.announceForAccessibility("Saved")}
					size="lg"
					testID="a11y-announce"
					variant="outline"
				>
					Announce
				</Button>
			</Card.Content>
		</Card>
	);
}
