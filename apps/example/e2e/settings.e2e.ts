import { expect, test } from "@delacour/warden-e2e";
import { signedIn, tapUntilVisible } from "./helpers/flows";
import { ids } from "./helpers/ids";

test("settings shows the account, toggles switches and signs out", async ({ device, screen }) => {
	await signedIn(device, screen, "grace@example.com");

	await tapUntilVisible(screen.getByTestId(ids.tabs.settings), screen.getByTestId(ids.settings.email));
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
