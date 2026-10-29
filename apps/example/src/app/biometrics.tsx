import { router } from "expo-router";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { useBiometricUnlock } from "@/modules/biometrics/hooks/use-biometric-unlock";

/**
 * Biometric unlock demo, reachable from Settings or `warden-example://biometrics` (no sign-in gate). The status text
 * and the Unlock button are `accessible` so the AX tree exposes their testIDs to specs.
 */
export default function Biometrics() {
	const { status, error, unlock } = useBiometricUnlock();

	const back = () => (router.canGoBack() ? router.back() : router.replace("/"));

	return (
		<Screen testID="bio-screen">
			<Screen.Navbar>
				<Screen.Navbar.BackButton onPress={back} testID="bio-back">
					<Screen.Navbar.Title>Biometrics</Screen.Navbar.Title>
				</Screen.Navbar.BackButton>
			</Screen.Navbar>
			<Screen.View className="gap-4 px-5">
				<View className="gap-1">
					<Text.Caption>Status</Text.Caption>
					<Text.Label accessible testID="bio-status">
						{status}
					</Text.Label>
				</View>
				<View className="gap-1">
					<Text.Caption>Last error</Text.Caption>
					<Text.Label accessible testID="bio-error">
						{error}
					</Text.Label>
				</View>
				<Button onPress={unlock} testID="bio-unlock">
					Unlock
				</Button>
			</Screen.View>
		</Screen>
	);
}
