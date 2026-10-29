import { expect, test } from "@delacour/warden-e2e";
import { fetchAndSettle } from "./helpers/conditions";
import { ids } from "./helpers/ids";
import { launch, openDeepLink, SPEC_OPTIONS } from "./helpers/steps";

test.use(SPEC_OPTIONS);

test("cold start offline shows the banner, going online recovers the fetch", async ({ app, device, screen }) => {
	await device.network.set("offline", { relaunch: true });
	await launch(app, screen);
	await openDeepLink(device, screen, "warden-example://conditions", ids.conditions.screen);

	await expect(screen.getByTestId(ids.conditions.offlineBanner)).toBeVisible({ timeout: 15_000 });
	expect(await fetchAndSettle(screen)).toBe("error");

	await device.network.set("online");
	await expect(screen.getByTestId(ids.conditions.offlineBanner)).toBeHidden({ timeout: 15_000 });
	expect(await fetchAndSettle(screen)).toBe("success");
});
