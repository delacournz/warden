import { Tabs } from "expo-router";
import type { ColorValue } from "react-native";
import { Icon } from "@/components/ui/icon";
import { IconListBullets, IconUser } from "@/lib/icons/central";

/** React Navigation hands tab icons a `ColorValue`; Icon takes a plain colour string. */
const asString = (color: ColorValue) => (typeof color === "string" ? color : undefined);

/** Bottom tabs; each tab button carries a testID (`tab-todos`, `tab-settings`). */
export default function TabsLayout() {
	return (
		<Tabs screenOptions={{ headerShown: false }}>
			<Tabs.Screen
				name="todos"
				options={{
					title: "Todos",
					tabBarButtonTestID: "tab-todos",
					tabBarIcon: ({ color }) => <Icon color={asString(color)} icon={IconListBullets} />,
				}}
			/>
			<Tabs.Screen
				name="settings"
				options={{
					title: "Settings",
					tabBarButtonTestID: "tab-settings",
					tabBarIcon: ({ color }) => <Icon color={asString(color)} icon={IconUser} />,
				}}
			/>
		</Tabs>
	);
}
