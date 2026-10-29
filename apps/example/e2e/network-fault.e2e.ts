import { expect, test } from "@delacour/warden-e2e";
import { fetchAndSettle, readValue } from "./helpers/conditions";
import { ids } from "./helpers/ids";
import { openConditions, SPEC_OPTIONS } from "./helpers/steps";

test.use(SPEC_OPTIONS);

test("a reset fault on the fetch host shows the error UI, clearing it recovers", async ({ app, device, screen }) => {
	await device.network.set("online", { relaunch: true });
	await openConditions(app, device, screen);

	await device.network.fault({ match: "speed.cloudflare.com", action: { kind: "reset" } });
	expect(await fetchAndSettle(screen)).toBe("error");
	expect(await readValue(screen, ids.conditions.fetchAttempts)).toBe("2");
	await expect(screen.getByTestId(ids.conditions.fetchError)).not.toHaveText("error: -");
	await expect(screen.getByTestId(ids.conditions.offlineBanner)).toBeHidden();

	await device.network.fault([]);
	expect(await fetchAndSettle(screen)).toBe("success");
});
