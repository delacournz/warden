import "@/styles/global.css";
import { Stack } from "expo-router";
import { Uniwind } from "uniwind";
import { DelacourProvider } from "@/components/ui/provider";
import { NavigationTheme } from "@/lib/expo/navigation-theme";
import { IS_E2E } from "@/modules/e2e/is-e2e";
import { SessionProvider } from "@/modules/session/contexts/session.context";
import { TodosProvider } from "@/modules/todos/contexts/todos.context";

/** The example app is the dark vault theme; Settings can still switch to light. Set at module scope so the first frame is dark. */
Uniwind.setTheme("dark");

export default function RootLayout() {
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
