import "@/styles/global.css";
import { MartianMono_400Regular } from "@expo-google-fonts/martian-mono";
import { MonaSans_400Regular, MonaSans_800ExtraBold, useFonts } from "@expo-google-fonts/mona-sans";
import { Stack } from "expo-router";
import { View } from "react-native";
import { DelacourProvider } from "@/components/ui/provider";
import { NavigationTheme } from "@/lib/expo/navigation-theme";
import { IS_E2E } from "@/modules/e2e/is-e2e";
import { SessionProvider } from "@/modules/session/contexts/session.context";
import { TodosProvider } from "@/modules/todos/contexts/todos.context";

/** Registers the docs faces (`styles/app.css` font tokens) once; nothing renders until they load or fail, so no text lays out in a fallback face. */
export default function RootLayout() {
	const [fontsLoaded, fontError] = useFonts({ MonaSans_400Regular, MonaSans_800ExtraBold, MartianMono_400Regular });

	if (!(fontsLoaded || fontError)) return <View className="flex-1 bg-background" />;

	return (
		<DelacourProvider isMotionCalm={IS_E2E}>
			<NavigationTheme>
				<SessionProvider>
					<TodosProvider>
						<Stack screenOptions={{ headerShown: false }} />
					</TodosProvider>
				</SessionProvider>
			</NavigationTheme>
		</DelacourProvider>
	);
}
