import { expect, test } from "@delacour/warden-e2e";
import { ids } from "./helpers/ids";
import { openDeepLink, SPEC_OPTIONS, signedIn } from "./helpers/steps";

test.use(SPEC_OPTIONS);

test("open a todo, mark it done, then delete it", async ({ app, screen }) => {
	await signedIn(app, screen);

	await screen.getByTestId(ids.todos.title("welcome")).tap({ until: screen.getByTestId(ids.detail.title) });
	await expect(screen.getByTestId(ids.detail.title)).toHaveText("Explore the example app");
	await expect(screen.getByTestId(ids.detail.status)).toHaveText("Active");

	await screen.getByTestId(ids.detail.toggle).tap();
	await expect(screen.getByTestId(ids.detail.status)).toHaveText("Done");

	await screen.getByTestId(ids.detail.remove).tap();
	await expect(screen.getByTestId(ids.todos.screen)).toBeVisible();
	await expect(screen.getByTestId(ids.todos.row("welcome"))).toHaveCount(0);
});

test("deep link opens a todo by id", async ({ app, device, screen }) => {
	await signedIn(app, screen);
	await openDeepLink(device, screen, "warden-example://todo/warden", ids.detail.title);
	await expect(screen.getByTestId(ids.detail.title)).toHaveText("Run the e2e suite with warden");
	await expect(screen.getByTestId(ids.detail.status)).toHaveText("Done");
});
