import { type App, type Device, expect, type Locator, type Screen, test } from "@delacour/warden-e2e";
import { ids } from "./helpers/ids";
import { launch, openDeepLink, SPEC_OPTIONS } from "./helpers/steps";

test.use({ ...SPEC_OPTIONS, systemAlerts: "off" });

/**
 * Taps Unlock and waits for the system biometric sheet before answering it: the app's status text leaves the
 * accessibility tree while the sheet is up, and a `match` sent before the sheet is armed is lost. iOS asks
 * "Allow X to use Face ID?" first on a fresh install; `alert("accept")` answers it when it is there.
 */
async function startUnlock(device: Pick<Device, "alert">, screen: Screen, platform: string): Promise<void> {
	const status = screen.getByTestId(ids.biometrics.status);
	await screen.getByTestId(ids.biometrics.unlock).tap({ until: async () => !(await status.isVisible()) });
	if (platform === "ios") await device.alert("accept");
	await expect(screen.getByTestId(ids.biometrics.status)).toBeHidden();
}

/**
 * Opens the biometrics screen through its deep link (it has no sign-in gate). Runs on `biometrics: true` devices,
 * which are enrolled before the app is installed.
 */
async function openBiometrics(app: Pick<App, "open">, device: Pick<Device, "openLink">, screen: Screen): Promise<void> {
	await launch(app, screen);
	await openDeepLink(device, screen, "warden-example://biometrics", ids.biometrics.screen);
}

const PRESENT_ATTEMPTS = 3;
const PRESENT_WINDOW_MS = 2_000;

/**
 * Presents a finger / face with `present` until `landed` shows. The simulator's matcher starts listening a moment
 * after the system sheet is up, and a presentation sent before that is dropped without an error (iOS Face ID did
 * this on about 1 run in 4), so one that changed nothing is sent again; one sent with no prompt open does nothing.
 */
async function presentUntil(present: () => Promise<unknown>, landed: Locator): Promise<void> {
	for (let attempt = 1; attempt <= PRESENT_ATTEMPTS; attempt++) {
		await present();
		if (await landed.isVisible()) return;
		try {
			await expect(landed).toBeVisible({ timeout: PRESENT_WINDOW_MS });
			return;
		} catch {
			// not shown within the window: present again, the last attempt's assertion below reports it
		}
	}
}

test("enrolled device unlocks on a matching biometric", async ({ app, device, screen, platform }) => {
	await openBiometrics(app, device, screen);
	expect((await device.biometrics.status()).enrolled).toBe(true);
	await expect(screen.getByTestId(ids.biometrics.status)).toHaveText("Ready");

	await startUnlock(device, screen, platform);
	await presentUntil(() => device.biometrics.match(), screen.getByTestId(ids.biometrics.status));

	await expect(screen.getByTestId(ids.biometrics.status)).toHaveText("Unlocked");
});

/**
 * A non-matching biometric is not a result the app sees: both systems keep the prompt open and say so
 * (iOS: a "Face Not Recognized" alert with Try Again / Cancel; Android: BiometricPrompt's "Not recognized"). The app
 * only hears back when the user cancels, so the spec asserts the system's rejection and then cancels it.
 */
test("a non-matching biometric is rejected and leaves the app locked", async ({ app, device, screen, platform }) => {
	await openBiometrics(app, device, screen);

	await startUnlock(device, screen, platform);
	const rejection = screen.getByText(platform === "ios" ? "Face Not Recognized" : "Not recognized");
	await presentUntil(() => device.biometrics.fail(), rejection);

	if (platform === "ios") {
		await expect(rejection).toBeVisible();
		expect(await device.alert({ button: "Cancel" })).toBe(true);
	} else {
		await expect(rejection).toBeVisible();
		await screen.getByTestId("button_negative").tap();
	}

	await expect(screen.getByTestId(ids.biometrics.status)).toHaveText("Cancelled");
	await expect(screen.getByTestId(ids.biometrics.error)).toHaveText("user_cancel");
});

test("an unenrolled device reports Not enrolled", { platforms: ["ios"] }, async ({ app, device, screen }) => {
	await device.biometrics.unenroll();
	await openBiometrics(app, device, screen);

	expect((await device.biometrics.status()).enrolled).toBe(false);
	await expect(screen.getByTestId(ids.biometrics.status)).toHaveText("Not enrolled");
});
