const { expect } = require("detox");
const { byId, signedIn, tapUntil } = require("./helpers/flows");
const { ids } = require("./helpers/ids");

describe("settings", () => {
	it("settings shows the account, toggles switches and signs out", async () => {
		await signedIn("grace@example.com");

		await tapUntil(ids.tabs.settings, ids.settings.email, "toBeVisible");
		await expect(byId(ids.settings.email)).toHaveText("grace@example.com");

		await expect(byId(ids.settings.notifications)).toHaveToggleValue(true);
		await byId(ids.settings.notifications).tap();
		await expect(byId(ids.settings.notifications)).toHaveToggleValue(false);

		await byId(ids.settings.darkMode).tap();
		await expect(byId(ids.settings.darkMode)).toHaveToggleValue(true);
		await byId(ids.settings.darkMode).tap();

		await byId(ids.settings.signOut).tap();
		await expect(byId(ids.welcome.screen)).toBeVisible();
	});
});
