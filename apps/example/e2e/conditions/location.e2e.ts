import { afterAll, beforeAll, describe, expect, test } from "@delacour/warden-e2e";
import { ids } from "../helpers/ids";
import { pollUntil } from "../helpers/poll";
import { openConditions, openDeepLink } from "../helpers/steps";

test.use({ launch: "none", systemAlerts: "accept" });

/** The geofence centre (`GEOFENCE` in the app) and points about 540 m north and south of it. */
const CENTER = { lat: 37.3349, lon: -122.009 };
const NORTH = { lat: 37.3398, lon: -122.009 };
const SOUTH = { lat: 37.33, lon: -122.009 };

/**
 * Location with permission granted, on one launch. The permission is set in `beforeAll`, before the launch: iOS
 * terminates a running app whose permission changes. A hook's changes are not put back by the runner the way a
 * test's are, so `afterAll` undoes it. A test's own location changes are cleared when it ends, so each test sets the
 * point it starts from.
 */
describe.serial("location granted", () => {
	beforeAll(async ({ app, device, screen }) => {
		await device.permissions.set({ location: "granted" });
		await device.location.set(NORTH);
		await openConditions(app, device, screen);
	});

	afterAll(async ({ device }) => {
		await device.location.clear();
		await device.permissions.set({ location: "unset" });
	});

	test("the Conditions screen reads the permission and a fix outside the geofence", async ({ device, screen }) => {
		await device.location.set(NORTH);
		await expect(screen.getByTestId(ids.conditions.permission)).toHaveText("granted", { timeout: 15_000 });
		await expect(screen.getByTestId(ids.conditions.geofence)).toHaveText("Outside", { timeout: 15_000 });
		await expect(screen.getByTestId(ids.conditions.geofenceLast)).toHaveText("None");
	});

	test("a route through the geofence shows Inside, then Outside after the exit", async ({ device, screen }) => {
		await device.location.route([NORTH, CENTER, SOUTH], { speedMps: 40, intervalS: 1 });
		await expect(screen.getByTestId(ids.conditions.geofence)).toHaveText("Inside", { timeout: 30_000 });
		await expect(screen.getByTestId(ids.conditions.geofenceLast)).toHaveText("Entered");

		await expect(screen.getByTestId(ids.conditions.geofence)).toHaveText("Outside", { timeout: 30_000 });
		await expect(screen.getByTestId(ids.conditions.geofenceLast)).toHaveText("Exited");
	});

	test("the location showcase tracks, then a route out of the geofence flips it to Outside and Moving", async ({
		device,
		screen,
	}) => {
		await device.location.set(CENTER);
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
	});

	test("stopping tracking clears the distance", async ({ screen }) => {
		await screen.getByTestId(ids.location.toggle).tap();
		const cleared = await pollUntil(
			() => screen.getByTestId(ids.location.distance).text(),
			(text) => text === "-" || text === "0 m",
			10_000
		);
		expect(["-", "0 m"]).toContain(cleared);
	});
});

/** A denied permission has to be in place before the launch, so this test launches on its own. */
test("a denied location permission shows denied, no fix and the Enable button", async ({ app, device, screen }) => {
	await device.permissions.set({ location: "denied" });
	await device.location.set(CENTER);
	await openConditions(app, device, screen);

	await expect(screen.getByTestId(ids.conditions.permission)).toHaveText("denied", { timeout: 10_000 });
	await expect(screen.getByTestId(ids.conditions.geofence)).toHaveText("Unknown");
	await expect(screen.getByTestId(ids.conditions.enableLocation)).toBeVisible();
});
