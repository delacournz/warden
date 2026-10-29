import { expect, test } from "@delacour/warden-e2e";
import { ids } from "./helpers/ids";
import { openConditions } from "./helpers/steps";

test.use({ launch: "none", systemAlerts: "accept" });

/** The geofence centre (`GEOFENCE` in the app) and points about 540 m north and south of it. */
const CENTER = { lat: 37.3349, lon: -122.009 };
const NORTH = { lat: 37.3398, lon: -122.009 };
const SOUTH = { lat: 37.33, lon: -122.009 };

test("a route through the geofence shows Inside, then Outside after the exit", async ({ app, device, screen }) => {
	// granted before the launch: iOS terminates a running app whose permission changes, and the prompt is not always raised
	await device.permissions.set({ location: "granted" });
	await device.location.set(NORTH);
	await openConditions(app, device, screen);

	const permission = screen.getByTestId(ids.conditions.permission);
	await expect(permission).toHaveText("granted", { timeout: 15_000 });
	await expect(screen.getByTestId(ids.conditions.geofence)).toHaveText("Outside", { timeout: 15_000 });
	await expect(screen.getByTestId(ids.conditions.geofenceLast)).toHaveText("None");

	await device.location.route([NORTH, CENTER, SOUTH], { speedMps: 40, intervalS: 1 });
	await expect(screen.getByTestId(ids.conditions.geofence)).toHaveText("Inside", { timeout: 30_000 });
	await expect(screen.getByTestId(ids.conditions.geofenceLast)).toHaveText("Entered");

	await expect(screen.getByTestId(ids.conditions.geofence)).toHaveText("Outside", { timeout: 30_000 });
	await expect(screen.getByTestId(ids.conditions.geofenceLast)).toHaveText("Exited");
});
