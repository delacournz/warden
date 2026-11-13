import { beforeAll, describe, expect, type Screen, test } from "@delacour/warden-e2e";
import { fetchAndSettle, readValue } from "../helpers/conditions";
import { ids } from "../helpers/ids";
import { pollUntil } from "../helpers/poll";
import { launch, openConditions, openDeepLink, SPEC_OPTIONS } from "../helpers/steps";

test.use(SPEC_OPTIONS);

const STATE_TIMEOUT_MS = 15_000;

/** Duration of the last fetch in ms, from "duration: 123 ms". */
async function durationMs(screen: Screen): Promise<number> {
	return Number.parseInt(await readValue(screen, ids.conditions.fetchDuration), 10);
}

/**
 * The Conditions screen's Fetch under every network condition, on one launch. The runner puts the network back to the
 * suite's `online` when each test ends, so every test starts online and sets only what it needs.
 */
describe.serial("fetch under network conditions", () => {
	beforeAll(async ({ app, device, screen }) => {
		await openConditions(app, device, screen);
	});

	test("online, a fetch succeeds on the first attempt", async ({ screen }) => {
		expect(await fetchAndSettle(screen)).toBe("success");
		expect(await readValue(screen, ids.conditions.fetchAttempts)).toBe("1");
		await expect(screen.getByTestId(ids.conditions.offlineBanner)).toBeHidden();
	});

	test("3g makes the fetch slower than online", async ({ device, screen }) => {
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

	test("going offline shows the banner and fails the fetch, online again hides it", async ({ device, screen }) => {
		await device.network.set("offline");
		await expect(screen.getByTestId(ids.conditions.offlineBanner)).toBeVisible({ timeout: STATE_TIMEOUT_MS });
		expect(await fetchAndSettle(screen)).toBe("error");

		await device.network.set("online");
		await expect(screen.getByTestId(ids.conditions.offlineBanner)).toBeHidden({ timeout: STATE_TIMEOUT_MS });
		expect(await fetchAndSettle(screen)).toBe("success");
	});

	test("a reset fault on the fetch host shows the error UI, clearing it recovers", async ({ device, screen }) => {
		await device.network.fault({ match: "speed.cloudflare.com", action: { kind: "reset" } });
		expect(await fetchAndSettle(screen)).toBe("error");
		expect(await readValue(screen, ids.conditions.fetchAttempts)).toBe("2");
		await expect(screen.getByTestId(ids.conditions.fetchError)).not.toHaveText("error: -");
		await expect(screen.getByTestId(ids.conditions.offlineBanner)).toBeHidden();

		await device.network.fault([]);
		expect(await fetchAndSettle(screen)).toBe("success");
	});

	test("a fetch that meets an outage retries once with the same idempotency key and succeeds", async ({
		device,
		screen,
	}) => {
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

	test("flapping the network is visible in status and stops cleanly", async ({ device, screen }) => {
		const flap = await device.network.flap({ up: "1s", down: "1s" });
		expect((await device.network.status()).flapping).toBe(true);
		await flap.stop();
		expect((await device.network.status()).flapping).toBe(false);

		await device.network.set("online");
		expect(await fetchAndSettle(screen)).toBe("success");
		expect(await readValue(screen, ids.conditions.fetchAttempts)).toBe("1");
	});

	test("during() runs under a condition and puts the previous one back", async ({ device, screen }) => {
		await device.network.during("offline", async () => {
			expect((await device.network.status()).condition).toEqual({ kind: "offline" });
			await expect(screen.getByTestId(ids.conditions.offlineBanner)).toBeVisible({ timeout: STATE_TIMEOUT_MS });
		});
		expect((await device.network.status()).condition).toEqual({ kind: "online" });
		await expect(screen.getByTestId(ids.conditions.offlineBanner)).toBeHidden({ timeout: STATE_TIMEOUT_MS });
	});
});

/** The network showcase probes every ~1.5 s, so it follows a condition without a tap. */
describe.serial("network showcase", () => {
	beforeAll(async ({ app, device, screen }) => {
		await launch(app, screen);
		await openDeepLink(device, screen, "warden-example://network", ids.network.screen);
	});

	test("online, the probes answer 200", async ({ screen }) => {
		await expect(screen.getByTestId(ids.network.state)).toHaveText("Online", { timeout: STATE_TIMEOUT_MS });
		await expect(screen.getByTestId(ids.network.last)).toHaveText(/^200 · /);
	});

	test("offline, the probes fail; online again, they answer", async ({ device, screen }) => {
		await device.network.set("offline");
		await expect(screen.getByTestId(ids.network.state)).toHaveText("Offline", { timeout: STATE_TIMEOUT_MS });
		await expect(screen.getByTestId(ids.network.last)).toHaveText(/^failed · /);

		await device.network.set("online");
		await expect(screen.getByTestId(ids.network.state)).toHaveText("Online", { timeout: STATE_TIMEOUT_MS });
		await expect(screen.getByTestId(ids.network.last)).toHaveText(/^200 · /);
	});

	test("pausing stops the probes and says so", async ({ screen }) => {
		await screen.getByTestId(ids.network.toggle).tap();
		await expect(screen.getByTestId(ids.network.state)).toHaveText("Paused");
		await screen.getByTestId(ids.network.toggle).tap();
		await expect(screen.getByTestId(ids.network.state)).toHaveText("Online", { timeout: STATE_TIMEOUT_MS });
	});
});

/** A cold start with no network is the point here, so it launches on its own. */
test("cold start offline shows the banner, going online recovers the fetch", async ({ app, device, screen }) => {
	await device.network.set("offline");
	await launch(app, screen);
	await openDeepLink(device, screen, "warden-example://conditions", ids.conditions.screen);

	await expect(screen.getByTestId(ids.conditions.offlineBanner)).toBeVisible({ timeout: STATE_TIMEOUT_MS });
	expect(await fetchAndSettle(screen)).toBe("error");

	await device.network.set("online");
	await expect(screen.getByTestId(ids.conditions.offlineBanner)).toBeHidden({ timeout: STATE_TIMEOUT_MS });
	expect(await fetchAndSettle(screen)).toBe("success");
});
