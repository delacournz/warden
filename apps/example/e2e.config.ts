import { mobile } from "@e2e-dev/mobile";
import type { E2EConfig } from "e2e";
import { BUNDLE_ID, devClientLaunchArguments, leasedDevices } from "./e2e/helpers/launch";

/**
 * tester.army e2e config. warden leases the devices, installs the build and runs the runner:
 * - `warden e2e example`: one `e2e run <flow>` per flow with `WARDEN_UDID` set (Release build, no Metro);
 * - `warden e2e example-dev`: one `e2e run <flows…>` for the whole pool (`WARDEN_UDIDS`, one worker per
 *   device) against the dev client, loaded from warden's Metro (`WARDEN_METRO_URL`).
 * The session is named after the first device, so parallel runners on one machine never share an
 * agent-device session.
 * Run by hand: `E2E_UDID=<udid> bunx e2e run e2e/sign-in.e2e.ts` (the app must already be installed).
 */
const devices = leasedDevices(process.env);
const [first] = devices;
const metroUrl = process.env.WARDEN_METRO_URL;

export default {
	tests: ["e2e/**/*.e2e.ts"],
	targets: [
		{
			name: "ios",
			engine: mobile({
				platform: "ios",
				...(first ? { device: devices.length > 1 ? devices : first, session: `warden-${first}` } : {}),
			}),
			app: {
				bundleId: BUNDLE_ID,
				...(metroUrl ? { launchArguments: devClientLaunchArguments(metroUrl) } : {}),
			},
		},
	],
	workers: Math.max(1, devices.length),
} satisfies E2EConfig;
