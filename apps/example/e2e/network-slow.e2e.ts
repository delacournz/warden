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
	await openConditions(app, device, screen);

	expect(await fetchAndSettle(screen)).toBe("success");
	const online = await durationMs(screen);

	await device.network.set("3g");
	expect(await fetchAndSettle(screen)).toBe("success");
	const slow = await durationMs(screen);

	/**
	 * The first Fetch warmed a keep-alive connection, so the 3g one pays one round trip (the preset's 100 ms) and not
	 * the 3-4 of a cold connection: assert the ordering with a margin, not a number.
	 */
	expect(slow).toBeGreaterThan(online + 50);
	await expect(screen.getByTestId(ids.conditions.offlineBanner)).toBeHidden();
});
