import type { ReactElement, ReactNode } from "react";
import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { screenVariants } from "./screen.variants";
import { ScreenContent } from "./screen-content";
import { ScreenNavbar } from "./screen-navbar";
import { ScreenRoot } from "./screen-root";

export type ScreenErrorProps = {
	/** Headline. Defaults to a generic apology. */
	title?: string;
	/** What went wrong, in a sentence the user can act on. */
	message: string;
	/** Back handler. Omit it and the navbar renders without a back control. */
	onBack?: () => void;
	/** Show the navbar at all. On by default — a dead end the user cannot leave is worse than the error. */
	showNavbar?: boolean;
	/** A retry button, or anything else worth offering below the message. */
	children?: ReactNode;
};

/**
 * A whole screen explaining that something failed.
 *
 * The title and message carry their own colour: a `View` does not cascade one
 * to a `Text` descendant.
 *
 * Deliberately plain. A richer empty state — illustration, media slot, its own
 * compound surface — is its own component, and building one into this would
 * make the error screen the place it lives.
 *
 * @example
 * <Screen.Error message={error.message} onBack={() => router.back()}>
 *   <Button onPress={refetch} size="sm">Try again</Button>
 * </Screen.Error>
 */
export function ScreenError({
	title = "Something went wrong",
	message,
	onBack,
	showNavbar = true,
	children,
}: ScreenErrorProps): ReactElement {
	const slots = screenVariants();

	return (
		<ScreenRoot>
			{showNavbar ? <ScreenNavbar>{onBack ? <ScreenNavbar.BackButton onPress={onBack} /> : null}</ScreenNavbar> : null}
			<ScreenContent insets={["bottom"]}>
				<View className={slots.errorContent()}>
					<View className="gap-1">
						<Text className={slots.errorTitle()}>{title}</Text>
						<Text className={slots.errorMessage()}>{message}</Text>
					</View>
					{children}
				</View>
			</ScreenContent>
		</ScreenRoot>
	);
}
ScreenError.displayName = "DelacourUI.Screen.Error";
