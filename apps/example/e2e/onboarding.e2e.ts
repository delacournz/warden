import { expect, test } from "@delacour/warden-e2e";
import { ids } from "./helpers/ids";
import { launch, nextStep, SPEC_OPTIONS } from "./helpers/steps";

test.use(SPEC_OPTIONS);

test("onboarding steps through to sign-in", async ({ app, screen }) => {
	await launch(app, screen);
	await expect(screen.getByTestId(ids.welcome.title)).toHaveText("Welcome");
	await nextStep(screen, "Plan");
	await nextStep(screen, "Test");
	await screen.getByTestId(ids.welcome.getStarted).tap();
	await expect(screen.getByTestId(ids.signIn.screen)).toBeVisible();
});
