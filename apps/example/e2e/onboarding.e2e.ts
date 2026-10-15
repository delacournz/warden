import { expect, test } from "@delacour/warden-e2e";
import { launch } from "./helpers/flows";
import { ids } from "./helpers/ids";

test("onboarding steps through to sign-in", async ({ device, screen }) => {
	await launch(device, screen);
	await expect(screen.getByTestId(ids.welcome.title)).toHaveText("Welcome");
	await screen.getByTestId(ids.welcome.next).tap();
	await expect(screen.getByTestId(ids.welcome.title)).toHaveText("Plan");
	await screen.getByTestId(ids.welcome.next).tap();
	await expect(screen.getByTestId(ids.welcome.title)).toHaveText("Test");
	await screen.getByTestId(ids.welcome.getStarted).tap();
	await expect(screen.getByTestId(ids.signIn.screen)).toBeVisible();
});
