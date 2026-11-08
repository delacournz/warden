import { expect, test } from "@delacour/warden-e2e";
import { ids } from "./helpers/ids";
import { openConditions, SPEC_OPTIONS } from "./helpers/steps";

test.use(SPEC_OPTIONS);

test("advancing the clock 15 days expires the trial, reset makes it active again", async ({ app, device, screen }) => {
	await openConditions(app, device, screen);
	await expect(screen.getByTestId(ids.conditions.trial)).toHaveText("Active");

	await device.clock.advance("15d");
	await expect(screen.getByTestId(ids.conditions.trial)).toHaveText("Expired", { timeout: 15_000 });

	await device.clock.reset();
	const refresh = screen.getByTestId(ids.conditions.refreshClock);
	await refresh.scrollTo();
	await refresh.tap();
	await expect(screen.getByTestId(ids.conditions.trial)).toHaveText("Active", { timeout: 15_000 });
});
