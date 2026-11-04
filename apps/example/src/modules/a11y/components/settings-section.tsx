import type { ReactElement } from "react";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { useAccessibilitySettings } from "../hooks/use-accessibility-settings";

/** The OS accessibility settings the app reads, live, as `on` / `off` text a spec can assert. */
export function SettingsSection(): ReactElement {
	const { screenReader, reduceMotion, boldText } = useAccessibilitySettings();
	const word = (on: boolean) => (on ? "on" : "off");

	return (
		<Card>
			<Card.Header>
				<Card.Title>System settings</Card.Title>
			</Card.Header>
			<Card.Content className="gap-1">
				<Text.Label accessible testID="a11y-screen-reader">
					{`Screen reader: ${word(screenReader)}`}
				</Text.Label>
				<Text.Label accessible testID="a11y-reduce-motion">
					{`Reduce motion: ${word(reduceMotion)}`}
				</Text.Label>
				<Text.Label accessible testID="a11y-bold-text">
					{`Bold text: ${word(boldText)}`}
				</Text.Label>
			</Card.Content>
		</Card>
	);
}
