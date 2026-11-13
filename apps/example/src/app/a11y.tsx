import { router, useLocalSearchParams } from "expo-router";
import { Screen } from "@/components/ui/screen";
import { AnnounceSection } from "@/modules/a11y/components/announce-section";
import { BadSection } from "@/modules/a11y/components/bad-section";
import { ControlsSection } from "@/modules/a11y/components/controls-section";
import { SettingsSection } from "@/modules/a11y/components/settings-section";

/**
 * Accessibility showcase, reachable from Settings or `warden-example://a11y`. The good screen passes
 * `warden ui a11y audit`; `?bad=1` appends known failures (unnamed button, 20x20 target, role in the name, label not
 * in the name) so the audit has something to find. It has no sign-in gate.
 */
export default function A11y() {
	const { bad } = useLocalSearchParams<{ bad?: string }>();
	const back = () => (router.canGoBack() ? router.back() : router.replace("/"));

	return (
		<Screen testID="a11y-screen">
			<Screen.Navbar>
				<Screen.Navbar.BackButton
					accessibilityLabel="Back, Accessibility"
					className="min-h-12"
					onPress={back}
					testID="a11y-back"
				>
					<Screen.Navbar.Title>Accessibility</Screen.Navbar.Title>
				</Screen.Navbar.BackButton>
			</Screen.Navbar>
			<Screen.ScrollArea contentContainerClassName="gap-4 px-5">
				<SettingsSection />
				<ControlsSection />
				<AnnounceSection />
				{bad === "1" ? <BadSection /> : null}
			</Screen.ScrollArea>
		</Screen>
	);
}
