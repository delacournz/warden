import { expect, test } from "@delacour/warden-e2e";
import { fetchAndSettle, readValue } from "./helpers/conditions";
import { ids } from "./helpers/ids";
import { pollUntil } from "./helpers/poll";
import { openConditions, SPEC_OPTIONS } from "./helpers/steps";

test.use(SPEC_OPTIONS);

test("a fetch that meets an outage retries once, with the same idempotency key, and succeeds", async ({
	app,
	device,
	screen,
}) => {
	await device.network.set("online", { relaunch: true });
	await openConditions(app, device, screen);

	await device.network.set("offline");
	await screen.getByTestId(ids.conditions.fetch).tap();
	await expect(screen.getByTestId(ids.conditions.fetchStatus)).toHaveText("loading");
	await device.network.set("online");

	const status = await pollUntil(
		() => screen.getByTestId(ids.conditions.fetchStatus).text(),
		(value) => value === "success" || value === "error",
		25_000
	);
	expect(status).toBe("success");
	expect(await readValue(screen, ids.conditions.fetchAttempts)).toBe("2");
	expect(await readValue(screen, ids.conditions.fetchKey)).toMatch(/^fetch-\d+-\d+$/);
});

test("flapping the network is visible in status and stops cleanly", async ({ app, device, screen }) => {
	await device.network.set("online", { relaunch: true });
	await openConditions(app, device, screen);

	const flap = await device.network.flap({ up: "1s", down: "1s" });
	expect((await device.network.status()).flapping).toBe(true);
	await flap.stop();
	expect((await device.network.status()).flapping).toBe(false);

	await device.network.set("online");
	expect(await fetchAndSettle(screen)).toBe("success");
	expect(await readValue(screen, ids.conditions.fetchAttempts)).toBe("1");
});
