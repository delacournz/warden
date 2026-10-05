import { test } from "@e2e-dev/mobile";
import { expect } from "e2e";
import { launch } from "./helpers/flows";
import { ids } from "./helpers/ids";

test("onboarding steps through to sign-in", async ({ app, device, screen }) => {
	await launch(app, device, screen);
	await expect(screen.getByTestId(ids.welcome.title)).toHaveText("Welcome");
	await screen.getByTestId(ids.welcome.next).tap();
	await expect(screen.getByTestId(ids.welcome.title)).toHaveText("Plan");
	await screen.getByTestId(ids.welcome.next).tap();
	await expect(screen.getByTestId(ids.welcome.title)).toHaveText("Test");
	await screen.getByTestId(ids.welcome.getStarted).tap();
	await expect(screen.getByTestId(ids.signIn.screen)).toBeVisible();
});
