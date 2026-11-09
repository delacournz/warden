import { beforeAll, type Device, describe, expect, test } from "@delacour/warden-e2e";
import { ENV_NAMES } from "@delacour/warden-e2e/env";
import { ids } from "../helpers/ids";
import { pollUntil } from "../helpers/poll";
import { launch, nextStep, SPEC_OPTIONS } from "../helpers/steps";

test.use(SPEC_OPTIONS);

/**
 * `device.devtools` talks to the app's JS runtime through Metro, so it only exists on the dev client
 * (`warden e2e example --dev`). The Release suite has no `WARDEN_METRO_URL`: the spec is skipped there.
 */
const onDevClient = process.env[ENV_NAMES.metroUrl] !== undefined;
const devtoolsTest = test.skipIf(!onDevClient);

/** `device.devtools`, or a failure naming why a dev-client run has none. */
function devtoolsOf(device: Device): NonNullable<Device["devtools"]> {
	const { devtools } = device;
	if (devtools === undefined) throw new Error("device.devtools is undefined although WARDEN_METRO_URL is set");
	return devtools;
}

/**
 * The dev client's JS runtime on one launch: evaluate, console capture, the React tree, fetch capture, then a JS
 * reload back to the first screen (last, since it resets the app).
 */
describe.serial("devtools", () => {
	/** bun still runs a group's `beforeAll` when every test in it is skipped: no launch on a Release run. */
	beforeAll(async ({ app, screen }) => {
		if (onDevClient) await launch(app, screen);
	});

	devtoolsTest("evaluate runs JS in the app", async ({ device }) => {
		expect(await devtoolsOf(device).evaluate("1+1")).toEqual({ success: true, data: 2 });
	});

	devtoolsTest("console lines from the app are captured", async ({ device }) => {
		const devtools = devtoolsOf(device);
		await devtools.evaluate('console.log("warden-e2e-probe")');
		const lines = await pollUntil(
			() => devtools.console.lines(),
			(all) => all.some((line) => line.text.includes("warden-e2e-probe"))
		);
		expect(lines.some((line) => line.level === "log" && line.text.includes("warden-e2e-probe"))).toBe(true);
	});

	devtoolsTest("the React tree carries the screen's testIDs", async ({ device }) => {
		const tree = await devtoolsOf(device).tree();
		if (!tree.success) throw new Error(`tree failed: ${tree.error.code}: ${tree.error.message}`);
		const testIDs = tree.data.components.map((component) => component.testID);
		expect(testIDs).toContain(ids.welcome.screen);
		expect(testIDs).toContain(ids.welcome.next);
	});

	devtoolsTest("fetches from the app are captured", async ({ device }) => {
		const devtools = devtoolsOf(device);
		// A refused loopback port: it needs no internet and still ends up as an entry (status 0, with an error).
		await devtools.evaluate('fetch("http://127.0.0.1:9/warden-e2e-probe").catch(() => undefined)');
		const entries = await pollUntil(
			() => devtools.network.entries(),
			(all) => all.some((entry) => entry.url.includes("warden-e2e-probe"))
		);
		expect(entries.find((entry) => entry.url.includes("warden-e2e-probe"))?.method).toBe("GET");
	});

	devtoolsTest("a JS reload resets the app to its first screen", async ({ device, screen }) => {
		await nextStep(screen, "Plan");
		const reloaded = await devtoolsOf(device).reloadJs();
		expect(reloaded).toEqual({ success: true, data: { method: "expo" } });
		await expect(screen.getByTestId(ids.welcome.title)).toHaveText("Welcome", { timeout: 30_000 });
	});
});
