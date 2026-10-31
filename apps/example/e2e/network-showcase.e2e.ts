import { expect, test } from "@delacour/warden-e2e";
import { ids } from "./helpers/ids";
import { launch, openDeepLink, SPEC_OPTIONS } from "./helpers/steps";

test.use(SPEC_OPTIONS);

const STATE_TIMEOUT_MS = 15_000;

test("the network showcase follows warden's network: online, offline, online again", async ({
	app,
	device,
	screen,
}) => {
	await device.network.set("online");
	await launch(app, screen);
	await openDeepLink(device, screen, "warden-example://network", ids.network.screen);

	await expect(screen.getByTestId(ids.network.state)).toHaveText("Online", { timeout: STATE_TIMEOUT_MS });
	await expect(screen.getByTestId(ids.network.last)).toHaveText(/^200 · /);

	await device.network.set("offline");
	await expect(screen.getByTestId(ids.network.state)).toHaveText("Offline", { timeout: STATE_TIMEOUT_MS });
	await expect(screen.getByTestId(ids.network.last)).toHaveText(/^failed · /);

	await device.network.set("online");
	await expect(screen.getByTestId(ids.network.state)).toHaveText("Online", { timeout: STATE_TIMEOUT_MS });
	await expect(screen.getByTestId(ids.network.last)).toHaveText(/^200 · /);
});

test("pausing stops the probes and says so", async ({ app, device, screen }) => {
	await device.network.set("online");
	await launch(app, screen);
	await openDeepLink(device, screen, "warden-example://network", ids.network.screen);
	await expect(screen.getByTestId(ids.network.state)).toHaveText("Online", { timeout: STATE_TIMEOUT_MS });

	await screen.getByTestId(ids.network.toggle).tap();
	await expect(screen.getByTestId(ids.network.state)).toHaveText("Paused");
	await screen.getByTestId(ids.network.toggle).tap();
	await expect(screen.getByTestId(ids.network.state)).toHaveText("Online", { timeout: STATE_TIMEOUT_MS });
});
