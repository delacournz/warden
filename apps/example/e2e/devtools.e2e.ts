import { type Device, expect, test } from "@delacour/warden-e2e";
import { ENV_NAMES } from "@delacour/warden-e2e/env";
import { FLOW_OPTIONS, launch } from "./helpers/flows";
import { ids } from "./helpers/ids";
import { pollUntil } from "./helpers/poll";

test.use(FLOW_OPTIONS);

/**
 * `device.devtools` talks to the app's JS runtime through Metro, so it only exists on the dev client
 * (`example-dev`). The Release suite has no `WARDEN_METRO_URL`: the flow is skipped there.
 */
const devtoolsTest = test.skipIf(process.env[ENV_NAMES.metroUrl] === undefined);

/** `device.devtools`, or a failure naming why a dev-client run has none. */
function devtoolsOf(device: Device): NonNullable<Device["devtools"]> {
	const { devtools } = device;
	if (devtools === undefined) throw new Error("device.devtools is undefined although WARDEN_METRO_URL is set");
	return devtools;
}

/**
 * One flow, one launch (like the other flows): evaluate, console capture, the React tree, fetch capture,
 * then a JS reload back to the first screen.
 */
devtoolsTest(
	"devtools evaluates, captures console and fetch, reads the React tree and reloads",
	async ({ app, device, screen }) => {
		await launch(app, screen);
		const devtools = devtoolsOf(device);

		expect(await devtools.evaluate("1+1")).toEqual({ success: true, data: 2 });

		await devtools.evaluate('console.log("warden-e2e-probe")');
		const lines = await pollUntil(
			() => devtools.console.lines(),
			(all) => all.some((line) => line.text.includes("warden-e2e-probe"))
		);
		expect(lines.some((line) => line.level === "log" && line.text.includes("warden-e2e-probe"))).toBe(true);

		const tree = await devtools.tree();
		if (!tree.success) throw new Error(`tree failed: ${tree.error.code}: ${tree.error.message}`);
		const testIDs = tree.data.components.map((component) => component.testID);
		expect(testIDs).toContain(ids.welcome.screen);
		expect(testIDs).toContain(ids.welcome.next);

		// A refused loopback port: it needs no internet and still ends up as an entry (status 0, with an error).
		await devtools.evaluate('fetch("http://127.0.0.1:9/warden-e2e-probe").catch(() => undefined)');
		const entries = await pollUntil(
			() => devtools.network.entries(),
			(all) => all.some((entry) => entry.url.includes("warden-e2e-probe"))
		);
		expect(entries.find((entry) => entry.url.includes("warden-e2e-probe"))?.method).toBe("GET");

		await screen.getByTestId(ids.welcome.next).tap();
		await expect(screen.getByTestId(ids.welcome.title)).toHaveText("Plan");
		const reloaded = await devtools.reloadJs();
		expect(reloaded).toEqual({ success: true, data: { method: "expo" } });
		await expect(screen.getByTestId(ids.welcome.title)).toHaveText("Welcome", { timeout: 30_000 });
	}
);
