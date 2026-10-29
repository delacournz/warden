import type { ReactElement } from "react";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { useNow } from "../hooks/use-now";
import { INSTALLED_AT, isTrialExpired, TRIAL_DAYS } from "../utils/trial";

/** The device clock and a 14-day trial that started when this launch did. */
export function ClockSection(): ReactElement {
	const now = useNow();
	const expired = isTrialExpired(now);

	return (
		<Card>
			<Card.Header>
				<Card.Title>Clock</Card.Title>
				<Card.Description>{`${TRIAL_DAYS}-day trial from ${new Date(INSTALLED_AT).toISOString()}`}</Card.Description>
			</Card.Header>
			<Card.Content className="gap-1">
				<Text.Caption accessible testID="conditions-now">
					{new Date(now).toISOString()}
				</Text.Caption>
				<Text.Label accessible testID="conditions-trial">
					{expired ? "Expired" : "Active"}
				</Text.Label>
			</Card.Content>
		</Card>
	);
}
