import { beforeAll, describe, expect, test } from "@delacour/warden-e2e";
import { ids } from "../helpers/ids";
import { launch, nextStep, SPEC_OPTIONS } from "../helpers/steps";

test.use(SPEC_OPTIONS);

/** The three-step onboarding on one launch: each test picks up on the step the one before it left. */
describe.serial("onboarding", () => {
	beforeAll(async ({ app, screen }) => {
		await launch(app, screen);
	});

	test("a fresh launch opens on the first step", async ({ screen }) => {
		await expect(screen.getByTestId(ids.welcome.title)).toHaveText("Welcome");
		await expect(screen.getByTestId(ids.welcome.next)).toBeVisible();
		await expect(screen.getByTestId(ids.welcome.getStarted)).toBeHidden();
	});

	test("Next walks to Plan, then Test", async ({ screen }) => {
		await nextStep(screen, "Plan");
		await nextStep(screen, "Test");
	});

	test("the last step swaps Next for Get started", async ({ screen }) => {
		await expect(screen.getByTestId(ids.welcome.getStarted)).toBeVisible();
		await expect(screen.getByTestId(ids.welcome.next)).toBeHidden();
	});

	test("Get started opens sign-in", async ({ screen }) => {
		await screen.getByTestId(ids.welcome.getStarted).tap({ until: screen.getByTestId(ids.signIn.screen) });
		await expect(screen.getByTestId(ids.signIn.screen)).toBeVisible();
	});

	test("Back from sign-in returns to the step it left", async ({ screen }) => {
		await screen.getByTestId(ids.signIn.back).tap({ until: screen.getByTestId(ids.welcome.screen) });
		await expect(screen.getByTestId(ids.welcome.title)).toHaveText("Test");
		await expect(screen.getByTestId(ids.welcome.getStarted)).toBeVisible();
	});
});
