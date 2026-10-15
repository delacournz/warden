import { expect, test } from "@delacour/warden-e2e";
import { signedIn } from "./helpers/flows";
import { ids } from "./helpers/ids";

test("open a todo, mark it done, then delete it", async ({ device, screen }) => {
	await signedIn(device, screen);

	await screen.getByTestId(ids.todos.title("welcome")).tap();
	await expect(screen.getByTestId(ids.detail.title)).toHaveText("Explore the example app");
	await expect(screen.getByTestId(ids.detail.status)).toHaveText("Active");

	await screen.getByTestId(ids.detail.toggle).tap();
	await expect(screen.getByTestId(ids.detail.status)).toHaveText("Done");

	await screen.getByTestId(ids.detail.remove).tap();
	await expect(screen.getByTestId(ids.todos.screen)).toBeVisible();
	await expect(screen.getByTestId(ids.todos.row("welcome"))).toHaveCount(0);
});

test("deep link opens a todo by id", async ({ device, screen }) => {
	await signedIn(device, screen);
	await device.openLink("warden-example://todo/warden");
	await expect(screen.getByTestId(ids.detail.title)).toHaveText("Run the e2e suite with warden");
	await expect(screen.getByTestId(ids.detail.status)).toHaveText("Done");
});
