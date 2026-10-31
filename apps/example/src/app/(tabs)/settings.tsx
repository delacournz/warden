import { router } from "expo-router";
import { useState } from "react";
import { Uniwind, useUniwind } from "uniwind";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { ListGroup } from "@/components/ui/list-group";
import { Screen } from "@/components/ui/screen";
import { Switch } from "@/components/ui/switch";
import {
	IconBell,
	IconClock,
	IconFingerPrint1,
	IconHand5Finger,
	IconLocation,
	IconMoon,
	IconSignalTower,
	IconWifiFull,
} from "@/lib/icons/central";
import { useSession } from "@/modules/session/contexts/session.context";

/** Profile card, notification + dark-mode switches, and sign out (back to welcome). */
export default function Settings() {
	const { session, signOut } = useSession();
	const { theme } = useUniwind();
	const [notifications, setNotifications] = useState(true);
	const email = session?.email ?? "guest";

	const leave = () => {
		signOut();
		router.replace("/welcome");
	};

	return (
		<Screen testID="settings-screen">
			<Screen.Navbar center={<Screen.Navbar.Title>Settings</Screen.Navbar.Title>} placement="static" />
			<Screen.ScrollArea contentContainerClassName="gap-5 px-5">
				<Card>
					<Card.Header>
						<Card.Action>
							<Avatar name={email} />
						</Card.Action>
						<Card.Title>Signed in</Card.Title>
						<Card.Description testID="settings-email">{email}</Card.Description>
					</Card.Header>
				</Card>
				<ListGroup>
					<ListGroup.Item>
						<ListGroup.ItemPrefix>
							<Icon icon={IconBell} />
						</ListGroup.ItemPrefix>
						<ListGroup.ItemContent>
							<ListGroup.ItemTitle>Notifications</ListGroup.ItemTitle>
						</ListGroup.ItemContent>
						<ListGroup.ItemSuffix>
							<Switch
								accessibilityLabel="Notifications"
								isSelected={notifications}
								onSelectedChange={setNotifications}
								testID="settings-notifications"
							/>
						</ListGroup.ItemSuffix>
					</ListGroup.Item>
					<ListGroup.Item>
						<ListGroup.ItemPrefix>
							<Icon icon={IconMoon} />
						</ListGroup.ItemPrefix>
						<ListGroup.ItemContent>
							<ListGroup.ItemTitle>Dark mode</ListGroup.ItemTitle>
						</ListGroup.ItemContent>
						<ListGroup.ItemSuffix>
							<Switch
								accessibilityLabel="Dark mode"
								isSelected={theme === "dark"}
								onSelectedChange={(on) => Uniwind.setTheme(on ? "dark" : "light")}
								testID="settings-dark-mode"
							/>
						</ListGroup.ItemSuffix>
					</ListGroup.Item>
				</ListGroup>
				<ListGroup>
					<ListGroup.Item
						accessibilityLabel="Gesture playground"
						accessible
						onPress={() => router.push("/gestures")}
						testID="settings-gestures"
					>
						<ListGroup.ItemPrefix>
							<Icon icon={IconHand5Finger} />
						</ListGroup.ItemPrefix>
						<ListGroup.ItemContent>
							<ListGroup.ItemTitle>Gesture playground</ListGroup.ItemTitle>
						</ListGroup.ItemContent>
						<ListGroup.ItemSuffix />
					</ListGroup.Item>
					<ListGroup.Item
						accessibilityLabel="Device conditions"
						accessible
						onPress={() => router.push("/conditions")}
						testID="settings-conditions"
					>
						<ListGroup.ItemPrefix>
							<Icon icon={IconWifiFull} />
						</ListGroup.ItemPrefix>
						<ListGroup.ItemContent>
							<ListGroup.ItemTitle>Device conditions</ListGroup.ItemTitle>
						</ListGroup.ItemContent>
						<ListGroup.ItemSuffix />
					</ListGroup.Item>
					<ListGroup.Item
						accessibilityLabel="Accessibility"
						accessible
						onPress={() => router.push("/a11y")}
						testID="settings-a11y"
					>
						<ListGroup.ItemPrefix>
							<Icon icon={IconBell} />
						</ListGroup.ItemPrefix>
						<ListGroup.ItemContent>
							<ListGroup.ItemTitle>Accessibility</ListGroup.ItemTitle>
						</ListGroup.ItemContent>
						<ListGroup.ItemSuffix />
					</ListGroup.Item>
					<ListGroup.Item
						accessibilityLabel="Biometrics"
						accessible
						onPress={() => router.push("/biometrics")}
						testID="settings-biometrics"
					>
						<ListGroup.ItemPrefix>
							<Icon icon={IconFingerPrint1} />
						</ListGroup.ItemPrefix>
						<ListGroup.ItemContent>
							<ListGroup.ItemTitle>Biometrics</ListGroup.ItemTitle>
						</ListGroup.ItemContent>
						<ListGroup.ItemSuffix />
					</ListGroup.Item>
					<ListGroup.Item
						accessibilityLabel="Network"
						accessible
						onPress={() => router.push("/network")}
						testID="settings-network"
					>
						<ListGroup.ItemPrefix>
							<Icon icon={IconSignalTower} />
						</ListGroup.ItemPrefix>
						<ListGroup.ItemContent>
							<ListGroup.ItemTitle>Network</ListGroup.ItemTitle>
						</ListGroup.ItemContent>
						<ListGroup.ItemSuffix />
					</ListGroup.Item>
					<ListGroup.Item
						accessibilityLabel="Location"
						accessible
						onPress={() => router.push("/location")}
						testID="settings-location"
					>
						<ListGroup.ItemPrefix>
							<Icon icon={IconLocation} />
						</ListGroup.ItemPrefix>
						<ListGroup.ItemContent>
							<ListGroup.ItemTitle>Location</ListGroup.ItemTitle>
						</ListGroup.ItemContent>
						<ListGroup.ItemSuffix />
					</ListGroup.Item>
					<ListGroup.Item
						accessibilityLabel="Clock"
						accessible
						onPress={() => router.push("/clock")}
						testID="settings-clock"
					>
						<ListGroup.ItemPrefix>
							<Icon icon={IconClock} />
						</ListGroup.ItemPrefix>
						<ListGroup.ItemContent>
							<ListGroup.ItemTitle>Clock</ListGroup.ItemTitle>
						</ListGroup.ItemContent>
						<ListGroup.ItemSuffix />
					</ListGroup.Item>
				</ListGroup>
			</Screen.ScrollArea>
			<Screen.Footer>
				<Button onPress={leave} size="lg" testID="settings-sign-out" variant="destructive-soft">
					Sign out
				</Button>
			</Screen.Footer>
		</Screen>
	);
}
