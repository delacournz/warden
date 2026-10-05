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
import { IconBell, IconMoon } from "@/lib/icons/central";
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
			</Screen.ScrollArea>
			<Screen.Footer>
				<Button onPress={leave} testID="settings-sign-out" variant="destructive-soft">
					Sign out
				</Button>
			</Screen.Footer>
		</Screen>
	);
}
