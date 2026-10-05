import "@/styles/global.css";
import { Stack } from "expo-router";
import { DelacourProvider } from "@/components/ui/provider";
import { NavigationTheme } from "@/lib/expo/navigation-theme";
import { IS_E2E } from "@/modules/e2e/is-e2e";
import { SessionProvider } from "@/modules/session/contexts/session.context";
import { TodosProvider } from "@/modules/todos/contexts/todos.context";

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
