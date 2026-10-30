import "@/styles/global.css";
import { ChakraPetch_400Regular, ChakraPetch_700Bold, useFonts } from "@expo-google-fonts/chakra-petch";
import { JetBrainsMono_500Medium } from "@expo-google-fonts/jetbrains-mono";
import { Stack } from "expo-router";
import { View } from "react-native";
import { Uniwind } from "uniwind";
import { DelacourProvider } from "@/components/ui/provider";
import { NavigationTheme } from "@/lib/expo/navigation-theme";
import { IS_E2E } from "@/modules/e2e/is-e2e";
import { SessionProvider } from "@/modules/session/contexts/session.context";
import { TodosProvider } from "@/modules/todos/contexts/todos.context";

/** The example app is the dark vault theme; Settings can still switch to light. Set at module scope so the first frame is dark. */
Uniwind.setTheme("dark");

export default function RootLayout() {
	const [fontsLoaded, fontError] = useFonts({ ChakraPetch_400Regular, ChakraPetch_700Bold, JetBrainsMono_500Medium });

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
