import { test } from "@e2e-dev/mobile";
import { expect } from "e2e";
import { acceptOpenIn, expectLabel, signedIn } from "./helpers/flows";
import { ids } from "./helpers/ids";

test("open a todo, mark it done, then delete it", async ({ app, device, screen }) => {
	await signedIn(app, device, screen);

	await screen.getByTestId(ids.todos.title("welcome")).tap();
	await expect(screen.getByTestId(ids.detail.title)).toHaveText("Explore the example app");
	await expectLabel(screen.getByTestId(ids.detail.status), "Active");

	await screen.getByTestId(ids.detail.toggle).tap();
	await expectLabel(screen.getByTestId(ids.detail.status), "Done");

	await screen.getByTestId(ids.detail.remove).tap();
	await expect(screen.getByTestId(ids.todos.screen)).toBeVisible();
	await expect(screen.getByTestId(ids.todos.row("welcome"))).toHaveCount(0);
});

test("deep link opens a todo by id", async ({ app, device, screen }) => {
	await signedIn(app, device, screen);
	await device.openLink("warden-example://todo/warden");
	await acceptOpenIn(device);
	await expect(screen.getByTestId(ids.detail.title)).toHaveText("Run the e2e suite with warden");
	await expectLabel(screen.getByTestId(ids.detail.status), "Done");
});
