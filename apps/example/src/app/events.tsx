import { IconChevronLeft } from "@central-icons-react-native/round-outlined-radius-1-stroke-1.5";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "@/hooks/use-theme-color";
import { useNotificationsDemo } from "@/modules/events/hooks/use-notifications-demo";

/**
 * Events demo for `warden ui push`: a button that asks for notification permission and two readouts the specs assert
 * on, `events-status` (the permission) and `events-last` (the title of the last notification delivered). Pushed
 * notifications show as a banner even with this screen in front. Reachable from `warden-example://events`.
 */
export default function Events() {
	const demo = useNotificationsDemo();
	const insets = useSafeAreaInsets();
	const foreground = useThemeColor("foreground");
	const back = () => (router.canGoBack() ? router.back() : router.replace("/"));

	return (
		<View className="flex-1 bg-background" style={{ paddingTop: insets.top }} testID="events-screen">
			<StatusBar style="light" />
			<View className="h-[52px] flex-row items-center px-5">
				<Pressable
					accessibilityLabel="Back"
					accessibilityRole="button"
					accessible
					className="flex-row items-center gap-1.5"
					hitSlop={12}
					onPress={back}
					testID="events-back"
				>
					<IconChevronLeft color={foreground} size={22} />
					<Text className="font-heading text-lg text-foreground">Events</Text>
				</Pressable>
			</View>
			<View className="gap-4 px-6 pt-2">
				<Pressable
					accessibilityLabel="Enable notifications"
					accessibilityRole="button"
					accessible
					className="h-12 items-center justify-center rounded-full border border-border active:opacity-85"
					onPress={demo.request}
					testID="events-enable"
				>
					<Text className="font-heading text-base text-foreground">Enable notifications</Text>
				</Pressable>
				<View className="gap-2 border-border border-y py-3">
					<View className="flex-row justify-between">
						<Text className="font-mono text-[13px] text-tertiary-foreground">permission</Text>
						<Text accessible className="font-mono text-[13px] text-foreground" testID="events-status">
							{demo.status}
						</Text>
					</View>
					<View className="flex-row justify-between">
						<Text className="font-mono text-[13px] text-tertiary-foreground">last</Text>
						<Text accessible className="font-mono text-[13px] text-foreground" testID="events-last">
							{demo.last}
						</Text>
					</View>
				</View>
			</View>
		</View>
	);
}
