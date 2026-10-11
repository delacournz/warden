/**
 * What an e2e launch of the example app shares between `e2e.config.ts` and `warden.config.ts`:
 * the bundle id, the devices warden leased and the iOS launch arguments that open the dev client
 * straight onto warden's Metro. Pure data, so the unit test pins it.
 */
export const BUNDLE_ID = "nz.co.delacour.warden.example";

type Env = Record<string, string | undefined>;

/**
 * Turns off the Expo dev menu at launch, its first-run onboarding sheet and the floating action
 * button, none of which a flow should ever have to dismiss.
 */
export const DEV_MENU_OFF = [
	"-EXDevMenuShowsAtLaunch",
	"NO",
	"-EXDevMenuIsOnboardingFinished",
	"YES",
	"-EXDevMenuShowFloatingActionButton",
	"NO",
];

/** `--initialUrl` skips the dev launcher's server picker and loads the bundle from `metroUrl`. */
export function devClientLaunchArguments(metroUrl: string): string[] {
	return ["--initialUrl", metroUrl, ...DEV_MENU_OFF];
}

/**
 * The devices this runner drives. A `mode: "single"` suite (`WARDEN_FLOW_PATHS` is set) gets the
 * whole pool in `WARDEN_UDIDS`; a per-flow job gets its one device in `WARDEN_UDID`; by hand,
 * `E2E_UDID`.
 */
export function leasedDevices(env: Env): string[] {
	const pool = env.WARDEN_FLOW_PATHS === undefined ? [] : (env.WARDEN_UDIDS ?? "").split(",").filter(Boolean);
	if (pool.length > 0) return pool;
	const one = env.WARDEN_UDID ?? env.E2E_UDID;
	return one ? [one] : [];
}
