import { type App, type Device, expect, type Screen, test } from "@delacour/warden-e2e";
import { ids } from "./helpers/ids";
import { openCamera, SPEC_OPTIONS } from "./helpers/steps";

test.use({ ...SPEC_OPTIONS, systemAlerts: "accept" });

/**
 * Opens the camera screen with camera access. Android takes the grant up front; iOS has no `simctl privacy` camera
 * service, so the app asks for real: Allow camera raises the system prompt, and `systemAlerts: "accept"` answers it on
 * the next look (no race with the prompt animating in).
 */
async function openWithCamera(
	app: Pick<App, "open">,
	device: Pick<Device, "openLink" | "permissions">,
	screen: Screen,
	platform: string
): Promise<void> {
	if (platform === "android") await device.permissions.set({ camera: "granted" });
	await openCamera(app, device, screen);
	const allow = screen.getByTestId(ids.camera.allow);
	if (await allow.isVisible()) await allow.tap();
	await expect(screen.getByTestId(ids.camera.ready)).toHaveText("ready", { timeout: 10_000 });
}

/**
 * The simulated camera behind a real expo-camera preview. The `camera` suite feeds `qr-hello.png` to the back camera
 * before the first launch (and claims Android emulators with `--camera`).
 */
test("the suite's feed reaches the preview, its QR decodes and a photo is taken from it", async ({
	app,
	device,
	screen,
	platform,
}) => {
	await openWithCamera(app, device, screen, platform);
	await expect(screen.getByTestId(ids.camera.qr)).toHaveText("hello", { timeout: 10_000 });

	await screen.getByTestId(ids.camera.shoot).tap();
	await expect(screen.getByTestId(ids.camera.photo)).not.toHaveText("none", { timeout: 10_000 });
	await expect(screen.getByTestId(ids.camera.error)).toHaveText("none");
});

/**
 * A feed set mid-test: on iOS it swaps live, on Android it shows on the next camera open, so the spec flips to the
 * front camera (a fresh open on both) and expects the new code there.
 */
test("a new feed set mid-test shows on the next camera", async ({ app, device, screen, platform }) => {
	await openWithCamera(app, device, screen, platform);
	await expect(screen.getByTestId(ids.camera.qr)).toHaveText("hello", { timeout: 10_000 });

	await device.camera.set("fixtures/camera/qr-world.png", { facing: "both" });
	await screen.getByTestId(ids.camera.flip).tap();
	await expect(screen.getByTestId(ids.camera.facing)).toHaveText("front");
	await expect(screen.getByTestId(ids.camera.qr)).toHaveText("world", { timeout: 10_000 });
	expect((await device.camera.status()).feeds.front?.path).toContain("front-");
});
