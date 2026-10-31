import { expect, test } from "@delacour/warden-e2e";
import { ids } from "./helpers/ids";
import { SPEC_OPTIONS, signedIn } from "./helpers/steps";

test.use(SPEC_OPTIONS);

test("settings shows the account, toggles switches and signs out", async ({ app, screen }) => {
	await signedIn(app, screen, "grace@example.com");

	await screen.getByTestId(ids.tabs.settings).tap({ until: screen.getByTestId(ids.settings.email) });
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
