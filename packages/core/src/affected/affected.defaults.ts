/** Where the default suite looks for flows, relative to the app root. */
export const DEFAULT_FLOWS_DIR = "e2e";
/** Simulators the default suite spreads its flows over (`--count` overrides). */
export const DEFAULT_E2E_COUNT = 2;
/**
 * Launch arguments the default suite opens the dev client with: no Expo dev menu at launch, no
 * first-run onboarding sheet and no floating button over the app (`metro.launchArgs`).
 */
export const DEV_MENU_OFF_ARGS = [
	"-EXDevMenuShowsAtLaunch",
	"NO",
	"-EXDevMenuIsOnboardingFinished",
	"YES",
	"-EXDevMenuShowFloatingActionButton",
	"NO",
];
