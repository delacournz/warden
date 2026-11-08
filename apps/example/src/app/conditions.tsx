import { router } from "expo-router";
import { Screen } from "@/components/ui/screen";
import { ClockSection } from "@/modules/conditions/components/clock-section";
import { LocationSection } from "@/modules/conditions/components/location-section";
import { NetworkSection, OfflineBanner } from "@/modules/conditions/components/network-section";

/**
 * Device-conditions playground, reachable from Settings or `warden-example://conditions`: NetInfo and a retrying
 * fetch, live location with a geofence, and the wall clock with a 14-day trial. It has no sign-in gate.
 */
export default function Conditions() {
	const back = () => (router.canGoBack() ? router.back() : router.replace("/"));

	return (
		<Screen testID="conditions-screen">
			<Screen.Navbar>
				<Screen.Navbar.BackButton onPress={back} testID="conditions-back">
					<Screen.Navbar.Title>Conditions</Screen.Navbar.Title>
				</Screen.Navbar.BackButton>
			</Screen.Navbar>
			<Screen.ScrollArea contentContainerClassName="gap-4 px-5">
				<OfflineBanner />
				<NetworkSection />
				<LocationSection />
				<ClockSection />
			</Screen.ScrollArea>
		</Screen>
	);
}
