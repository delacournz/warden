const { expect } = require("detox");
const { byId, openDeepLink, signedIn, tapUntil } = require("./helpers/flows");
const { ids } = require("./helpers/ids");

describe("todo detail", () => {
	it("open a todo, mark it done, then delete it", async () => {
		await signedIn();

		await tapUntil(ids.todos.title("welcome"), ids.detail.title, "toBeVisible");
		await expect(byId(ids.detail.title)).toHaveText("Explore the example app");
		await expect(byId(ids.detail.status)).toHaveText("Active");

		await byId(ids.detail.toggle).tap();
		await expect(byId(ids.detail.status)).toHaveText("Done");

		await byId(ids.detail.remove).tap();
		await expect(byId(ids.todos.screen)).toBeVisible();
		await expect(byId(ids.todos.row("welcome"))).not.toExist();
	});

	it("deep link opens a todo by id", async () => {
		await signedIn();
		await openDeepLink("warden-example://todo/warden", ids.detail.title);
		await expect(byId(ids.detail.title)).toHaveText("Run the e2e suite with warden");
		await expect(byId(ids.detail.status)).toHaveText("Done");
	});
});
