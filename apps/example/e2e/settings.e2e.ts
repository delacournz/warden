import { test } from "@e2e-dev/mobile";
import { expect } from "e2e";
import { signedIn } from "./helpers/flows";
import { ids } from "./helpers/ids";

test("settings shows the account, toggles switches and signs out", async ({ app, device, screen }) => {
	await signedIn(app, device, screen, "grace@example.com");

	await screen.getByTestId(ids.tabs.settings).tap();
	await expect(screen.getByTestId(ids.settings.email)).toHaveText("grace@example.com");

	await expect(screen.getByTestId(ids.settings.notifications)).toBeChecked();
	await screen.getByTestId(ids.settings.notifications).tap();
	await expect(screen.getByTestId(ids.settings.notifications)).toBeChecked({ checked: false });

	await screen.getByTestId(ids.settings.darkMode).tap();
	await expect(screen.getByTestId(ids.settings.darkMode)).toBeChecked();
	await screen.getByTestId(ids.settings.darkMode).tap();

	await screen.getByTestId(ids.settings.signOut).tap();
	await expect(screen.getByTestId(ids.welcome.screen)).toBeVisible();
});
