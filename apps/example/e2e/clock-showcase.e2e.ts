import { expect, test } from "@delacour/warden-e2e";
import { ids } from "./helpers/ids";
import { launch, openDeepLink, SPEC_OPTIONS } from "./helpers/steps";

test.use(SPEC_OPTIONS);

test("advancing the clock ticks days off the trial, expires it, and reset brings it back", async ({
	app,
	device,
	screen,
}) => {
	await launch(app, screen);
	await openDeepLink(device, screen, "warden-example://clock", ids.clock.screen);
	await expect(screen.getByTestId(ids.clock.trial)).toHaveText("Active");
	await expect(screen.getByTestId(ids.clock.days)).toHaveText("14");
	await expect(screen.getByTestId(ids.clock.state)).toHaveText("14 days left");

	await device.clock.advance("10d");
	await expect(screen.getByTestId(ids.clock.days)).toHaveText("4", { timeout: 15_000 });
	await expect(screen.getByTestId(ids.clock.offset)).toHaveText("+10d 0h", { timeout: 15_000 });

	await device.clock.advance("5d");
	await expect(screen.getByTestId(ids.clock.trial)).toHaveText("Expired", { timeout: 15_000 });
	await expect(screen.getByTestId(ids.clock.state)).toHaveText("Trial expired");
	await expect(screen.getByTestId(ids.clock.days)).toHaveText("0");

	await device.clock.reset();
	await expect(screen.getByTestId(ids.clock.trial)).toHaveText("Active", { timeout: 15_000 });
	await expect(screen.getByTestId(ids.clock.days)).toHaveText("14");
	await expect(screen.getByTestId(ids.clock.offset)).toHaveText("0s");
});
