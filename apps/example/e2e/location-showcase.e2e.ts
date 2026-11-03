import { expect, test } from "@delacour/warden-e2e";
import { ids } from "./helpers/ids";
import { pollUntil } from "./helpers/poll";
import { launch, openDeepLink } from "./helpers/steps";

test.use({ launch: "none", systemAlerts: "accept" });

const CENTER = { lat: 37.3349, lon: -122.009 };
/** About 540 m north of the centre: well outside the 150 m geofence. */
const NORTH = { lat: 37.3398, lon: -122.009 };

test("tracking draws the track, then a route out of the geofence flips it to Outside and Moving", async ({
	app,
	device,
	screen,
}) => {
	// granted before the launch: iOS terminates a running app whose permission changes
	await device.permissions.set({ location: "granted" });
	await device.location.set(CENTER);
	await launch(app, screen);
	await openDeepLink(device, screen, "warden-example://location", ids.location.screen);

	await expect(screen.getByTestId(ids.location.state)).toHaveText("Not tracking");
	await expect(screen.getByTestId(ids.location.geofence)).toHaveText("-");

	await screen.getByTestId(ids.location.toggle).tap();
	await expect(screen.getByTestId(ids.location.geofence)).toHaveText("Inside", { timeout: 20_000 });
	await expect(screen.getByTestId(ids.location.state)).toHaveText("Holding still");
	await expect(screen.getByTestId(ids.location.coords)).toHaveText("37.33490, -122.00900");
	const firstFixes = Number(await screen.getByTestId(ids.location.fixes).text());
	expect(firstFixes).toBeGreaterThan(0);

	await device.location.route([CENTER, NORTH], { speedMps: 40, intervalS: 1 });
	await expect(screen.getByTestId(ids.location.geofence)).toHaveText("Outside", { timeout: 30_000 });
	await expect(screen.getByTestId(ids.location.state)).toContainText("Moving");
	const fixes = await pollUntil(
		() => screen.getByTestId(ids.location.fixes).text(),
		(text) => Number(text) > firstFixes,
		10_000
	);
	expect(Number(fixes)).toBeGreaterThan(firstFixes);
	const distance = await screen.getByTestId(ids.location.distance).text();
	expect(distance).not.toBe("0 m");
	expect(distance).not.toBe("-");

	await screen.getByTestId(ids.location.toggle).tap();
	const cleared = await pollUntil(
		() => screen.getByTestId(ids.location.distance).text(),
		(text) => text === "-" || text === "0 m",
		10_000
	);
	expect(["-", "0 m"]).toContain(cleared);
});
