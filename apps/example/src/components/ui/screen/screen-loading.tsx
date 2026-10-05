import type { ReactElement } from "react";
import { View } from "react-native";
import { Spinner } from "@/components/ui/spinner";
import { screenVariants } from "./screen.variants";
import { ScreenContent } from "./screen-content";
import { ScreenNavbar } from "./screen-navbar";
import { ScreenRoot } from "./screen-root";

export type ScreenLoadingProps = {
	/** Title for the navbar, if the screen shows one. */
	title?: string;
	/** Back handler. Omit it and the navbar renders without a back control. */
	onBack?: () => void;
	/** Show the navbar at all. On by default, so the frame does not shift when the content arrives. */
	showNavbar?: boolean;
};

/**
 * A whole screen showing a spinner — the placeholder a route renders while its
 * data is in flight.
 *
 * Keeps the navbar by default so the frame does not jump when the real content
 * replaces it, and so the user can still go back out of a slow load.
 *
 * @example
 * if (isPending) return <Screen.Loading onBack={() => router.back()} title="Settings" />;
 */
export function ScreenLoading({ title, onBack, showNavbar = true }: ScreenLoadingProps): ReactElement {
	return (
		<ScreenRoot>
			{showNavbar ? (
				<ScreenNavbar>
					{onBack ? (
						<ScreenNavbar.BackButton onPress={onBack}>
							{title ? <ScreenNavbar.Title>{title}</ScreenNavbar.Title> : null}
						</ScreenNavbar.BackButton>
					) : title ? (
						<ScreenNavbar.Title>{title}</ScreenNavbar.Title>
					) : null}
				</ScreenNavbar>
			) : null}
			<ScreenContent>
				<View className={screenVariants().loading()}>
					<Spinner size="xl" />
				</View>
			</ScreenContent>
		</ScreenRoot>
	);
}
ScreenLoading.displayName = "DelacourUI.Screen.Loading";
