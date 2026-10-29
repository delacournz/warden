import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { usePosition } from "../hooks/use-position";
import { GEOFENCE } from "../utils/geofence";

/** Permission, live coordinates and the geofence verdict ("Inside" / "Outside") with the last enter / exit. */
export function LocationSection(): ReactElement {
	const { permission, position, inside, lastEvent, requestPermission } = usePosition();
	const verdict = inside === null ? "Unknown" : inside ? "Inside" : "Outside";
	const last = lastEvent ? (lastEvent.kind === "enter" ? "Entered" : "Exited") : "None";

	return (
		<Card>
			<Card.Header>
				<Card.Title>Location</Card.Title>
				<Card.Description>{`${GEOFENCE.radiusM} m geofence at ${GEOFENCE.lat}, ${GEOFENCE.lon}`}</Card.Description>
			</Card.Header>
			<Card.Content className="gap-1">
				<Text.Caption accessible testID="conditions-permission">
					{permission}
				</Text.Caption>
				<Text.Caption accessible testID="conditions-coords">
					{position ? `${position.lat.toFixed(4)},${position.lon.toFixed(4)}` : "-"}
				</Text.Caption>
				<Text.Label accessible testID="conditions-geofence">
					{verdict}
				</Text.Label>
				<Text.Caption accessible testID="conditions-geofence-last">
					{last}
				</Text.Caption>
			</Card.Content>
			{permission === "granted" ? null : (
				<Card.Footer>
					<Button onPress={requestPermission} testID="conditions-location-enable" variant="outline">
						Enable location
					</Button>
				</Card.Footer>
			)}
		</Card>
	);
}
