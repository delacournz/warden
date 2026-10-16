const { expect } = require("detox");
const { byId, launch, nextStep } = require("./helpers/flows");
const { ids } = require("./helpers/ids");

describe("onboarding", () => {
	it("onboarding steps through to sign-in", async () => {
		await launch();
		await expect(byId(ids.welcome.title)).toHaveText("Welcome");
		await nextStep("Plan");
		await nextStep("Test");
		await byId(ids.welcome.getStarted).tap();
		await expect(byId(ids.signIn.screen)).toBeVisible();
	});
});
