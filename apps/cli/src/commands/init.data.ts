import {
	DEFAULT_E2E_COUNT,
	DEFAULT_E2E_RUNNER,
	DEFAULT_FLOWS_DIR,
} from "@delacour/warden-core/affected/affected.defaults";

export type InitApp = { name: string; bundleId: { ios?: string; android?: string } };

const str = (value: string) => JSON.stringify(value);

function bundleIds({ ios, android }: InitApp["bundleId"]): string {
	const ids = [ios ? `ios: ${str(ios)}` : undefined, android ? `android: ${str(android)}` : undefined];
	return `{ ${ids.filter((id) => id !== undefined).join(", ")} }`;
}

/** The starter `warden.config.ts`: the project and the suite `warden e2e` otherwise assumes, spelled out to edit. */
export function wardenConfigSource(app: InitApp): string {
	const name = str(app.name);
	return `/**
 * warden config.
 * - \`warden dev\`: the dev client on a leased simulator, on a Metro port of its own.
 * - \`warden e2e\`: the flows in ${DEFAULT_FLOWS_DIR}/ on the dev client, spread over leased simulators (\`--count N\`).
 * For autocompletion: \`bun add -d @delacour/warden\` and wrap this in \`defineConfig\` from "@delacour/warden/config".
 */
export default {
	projects: [{ name: ${name}, bundleId: ${bundleIds(app.bundleId)} }],
	e2e: {
		[${name}]: {
			project: ${name},
			flowsDir: ${str(DEFAULT_FLOWS_DIR)},
			platform: "ios",
			runner: [${DEFAULT_E2E_RUNNER.map(str).join(", ")}],
			mode: "single",
			count: ${DEFAULT_E2E_COUNT},
			app: true,
			metro: {},
		},
	},
};
`;
}

/** The starter tester.army `e2e.config.ts`: drives the devices warden leased, on the Metro warden started. */
export function e2eConfigSource(bundleId: string): string {
	return `import { mobile } from "@e2e-dev/mobile";
import type { E2EConfig } from "e2e";

/**
 * tester.army e2e config, run by \`warden e2e\`: warden leases the simulators, installs the dev build
 * and starts Metro, then one \`e2e run\` drives the whole pool (one worker per device).
 * By hand: \`E2E_UDID=<udid> bunx e2e run ${DEFAULT_FLOWS_DIR}/smoke.e2e.ts\` (the app must already be installed).
 */
const env = process.env;
// a single-runner suite gets the pool in WARDEN_UDIDS; a per-flow job its one device in WARDEN_UDID
const pool = env.WARDEN_FLOW_PATHS === undefined ? [] : (env.WARDEN_UDIDS ?? "").split(",").filter(Boolean);
const one = env.WARDEN_UDID ?? env.E2E_UDID;
const devices = pool.length > 0 ? pool : one ? [one] : [];
const [first] = devices;
const metroUrl = env.WARDEN_METRO_URL;

/** No Expo dev menu, onboarding sheet or floating button over the app. */
const DEV_MENU_OFF = [
	"-EXDevMenuShowsAtLaunch",
	"NO",
	"-EXDevMenuIsOnboardingFinished",
	"YES",
	"-EXDevMenuShowFloatingActionButton",
	"NO",
];

export default {
	tests: ["${DEFAULT_FLOWS_DIR}/**/*.e2e.ts"],
	targets: [
		{
			name: "ios",
			engine: mobile({
				platform: "ios",
				...(first ? { device: devices.length > 1 ? devices : first, session: \`warden-\${first}\` } : {}),
			}),
			app: {
				bundleId: ${str(bundleId)},
				// --initialUrl loads the bundle from warden's Metro, skipping the dev launcher's server picker
				...(metroUrl ? { launchArguments: ["--initialUrl", metroUrl, ...DEV_MENU_OFF] } : {}),
			},
		},
	],
	workers: Math.max(1, devices.length),
} satisfies E2EConfig;
`;
}

/** A first flow: the app opens. */
export const SMOKE_FLOW_SOURCE = `import { test } from "@e2e-dev/mobile";

test("the app opens", async ({ app, device }) => {
	await app.open();
	// a prompt left over from an earlier run would cover the app
	await device.alert("dismiss").catch(() => undefined);
	// next: assert on your first screen, e.g.
	// await expect(screen.getByTestId("home")).toBeVisible();   (expect from "e2e", screen from the fixtures)
});
`;
