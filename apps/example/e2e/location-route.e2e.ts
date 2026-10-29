import { expect, test } from "@delacour/warden-e2e";
import { ids } from "./helpers/ids";
import { pollUntil } from "./helpers/poll";
import { openConditions } from "./helpers/steps";

test.use({ launch: "none", systemAlerts: "accept" });

/** The geofence centre (`GEOFENCE` in the app) and points about 540 m north and south of it. */
const CENTER = { lat: 37.3349, lon: -122.009 };
const NORTH = { lat: 37.3398, lon: -122.009 };
const SOUTH = { lat: 37.33, lon: -122.009 };

test("a route through the geofence shows Inside, then Outside after the exit", async ({ app, device, screen }) => {
	await device.location.set(NORTH);
	await openConditions(app, device, screen);

	/**
	 * The permission outlives a run on a reused device: ask only when it is not granted already. iOS sometimes raises
	 * no prompt for a process that asked early (nothing on screen, `canAskAgain` still true), so the second attempt
	 * asks again from a fresh launch.
	 */
	const permission = screen.getByTestId(ids.conditions.permission);
	for (let attempt = 1; attempt <= 2; attempt++) {
		await expect(permission).toBeVisible();
		const granted = await pollUntil(
			() => permission.text(),
			(text) => text === "granted",
			3_000
		);
		if (granted === "granted") break;
		const enable = screen.getByTestId(ids.conditions.enableLocation);
		await enable.scrollTo();
		await enable.tap({ until: async () => (await permission.text()) !== "undetermined" });
		if ((await permission.text()) !== "undetermined") break;
		if (attempt === 1) await openConditions(app, device, screen);
	}
	await expect(permission).toHaveText("granted", { timeout: 15_000 });
	await expect(screen.getByTestId(ids.conditions.geofence)).toHaveText("Outside", { timeout: 15_000 });
	await expect(screen.getByTestId(ids.conditions.geofenceLast)).toHaveText("None");

	await device.location.route([NORTH, CENTER, SOUTH], { speedMps: 40, intervalS: 1 });
	await expect(screen.getByTestId(ids.conditions.geofence)).toHaveText("Inside", { timeout: 30_000 });
	await expect(screen.getByTestId(ids.conditions.geofenceLast)).toHaveText("Entered");

	await expect(screen.getByTestId(ids.conditions.geofence)).toHaveText("Outside", { timeout: 30_000 });
	await expect(screen.getByTestId(ids.conditions.geofenceLast)).toHaveText("Exited");
});
