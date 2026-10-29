import { expect, test } from "@delacour/warden-e2e";
import { fetchAndSettle, readValue } from "./helpers/conditions";
import { ids } from "./helpers/ids";
import { openConditions, SPEC_OPTIONS } from "./helpers/steps";

test.use(SPEC_OPTIONS);

/** Duration of the last fetch in ms, from "duration: 123 ms". */
async function durationMs(screen: Parameters<typeof readValue>[0]): Promise<number> {
	return Number.parseInt(await readValue(screen, ids.conditions.fetchDuration), 10);
}

test("3g makes the fetch slower than online", async ({ app, device, screen }) => {
	await device.network.set("online", { relaunch: true });
	await openConditions(app, device, screen);

	expect(await fetchAndSettle(screen)).toBe("success");
	const online = await durationMs(screen);

	await device.network.set("3g");
	expect(await fetchAndSettle(screen)).toBe("success");
	const slow = await durationMs(screen);

	expect(slow).toBeGreaterThan(300);
	expect(slow).toBeGreaterThan(online);
	await expect(screen.getByTestId(ids.conditions.offlineBanner)).toBeHidden();
});
