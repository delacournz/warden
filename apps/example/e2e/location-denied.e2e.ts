import { expect, test } from "@delacour/warden-e2e";
import { ids } from "./helpers/ids";
import { openConditions } from "./helpers/steps";

test.use({ launch: "none", systemAlerts: "dismiss" });

test("a denied location permission shows denied, no fix and the Enable button", async ({ app, device, screen }) => {
	await device.permissions.set({ location: "denied" });
	await device.location.set({ lat: 37.3349, lon: -122.009 });
	await openConditions(app, device, screen);

	await expect(screen.getByTestId(ids.conditions.permission)).toHaveText("denied", { timeout: 10_000 });
	await expect(screen.getByTestId(ids.conditions.geofence)).toHaveText("Unknown");
	await expect(screen.getByTestId(ids.conditions.enableLocation)).toBeVisible();
});
