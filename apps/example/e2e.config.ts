import { mobile } from "@e2e-dev/mobile";
import type { E2EConfig } from "e2e";

/**
 * tester.army e2e config. warden leases the device and installs the build (`warden e2e example`), then
 * runs one `e2e run <flow>` per flow with `WARDEN_UDID` set; the session is named after the device so
 * parallel runners on one machine never share an agent-device session.
 * Run by hand: `E2E_UDID=<udid> bunx e2e run e2e/sign-in.e2e.ts` (the app must already be installed).
 */
const udid = process.env.WARDEN_UDID ?? process.env.E2E_UDID;

export default {
	tests: ["e2e/**/*.e2e.ts"],
	targets: [
		{
			name: "ios",
			engine: mobile({
				platform: "ios",
				...(udid ? { device: udid, session: `warden-${udid}` } : {}),
			}),
			app: { bundleId: "nz.co.delacour.warden.example" },
		},
	],
	workers: 1,
} satisfies E2EConfig;
