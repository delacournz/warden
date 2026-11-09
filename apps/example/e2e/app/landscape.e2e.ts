import { afterEach, type Device, expect, type Screen, test } from "@delacour/warden-e2e";
import { ids } from "../helpers/ids";
import { openLandscape, SPEC_OPTIONS } from "../helpers/steps";

test.use(SPEC_OPTIONS);

type Turned = "landscapeLeft" | "landscapeRight";

const CORNERS = [
	{ testId: ids.landscape.topLeft, name: "top-left" },
	{ testId: ids.landscape.topRight, name: "top-right" },
	{ testId: ids.landscape.bottomLeft, name: "bottom-left" },
	{ testId: ids.landscape.bottomRight, name: "bottom-right" },
] as const;

/**
 * Turns the device, waits for the app to draw landscape and for the rotation animation to end (a touch sent while it
 * runs is dropped, even at the right point), then taps each corner by testID. A touch sent on the wrong
 * axes lands on another corner or on nothing, so each corner is checked by name, and the count proves no tap was lost.
 */
async function tapEveryCorner(device: Device, screen: Screen, orientation: Turned): Promise<void> {
	expect(await device.orientation(orientation)).toBe(orientation);
	await expect(screen.getByTestId(ids.landscape.layout)).toHaveText("landscape", { timeout: 10_000 });
	await device.settle({ quietMs: 300, timeout: 5_000 });
	for (const [index, corner] of CORNERS.entries()) {
		await screen.getByTestId(corner.testId).tap();
		await expect(screen.getByTestId(ids.landscape.last)).toHaveText(corner.name);
		await expect(screen.getByTestId(ids.landscape.presses)).toHaveText(String(index + 1));
	}
}

/** The device goes back upright after each test, so no later spec starts on a turned device. */
afterEach(async ({ device }) => {
	await device.orientation("portrait");
});

test("taps land on every corner in landscapeLeft", { platforms: ["ios"] }, async ({ app, device, screen }) => {
	await openLandscape(app, device, screen);
	await tapEveryCorner(device, screen, "landscapeLeft");
});

test("taps land on every corner in landscapeRight", { platforms: ["ios"] }, async ({ app, device, screen }) => {
	await openLandscape(app, device, screen);
	await tapEveryCorner(device, screen, "landscapeRight");
});
