import { beforeAll, describe, expect, test } from "@delacour/warden-e2e";
import { ids } from "../helpers/ids";
import { openConditions, openDeepLink, SPEC_OPTIONS } from "../helpers/steps";

test.use(SPEC_OPTIONS);

const CLOCK_TIMEOUT_MS = 15_000;

/**
 * The wall clock on one launch: the Conditions screen's trial first, then the clock showcase. The runner resets the
 * clock when each test ends, so every test starts on real time.
 */
describe.serial("clock", () => {
	beforeAll(async ({ app, device, screen }) => {
		await openConditions(app, device, screen);
	});

	test("advancing the clock 15 days expires the trial, reset makes it active again", async ({ device, screen }) => {
		await expect(screen.getByTestId(ids.conditions.trial)).toHaveText("Active");

		await device.clock.advance("15d");
		await expect(screen.getByTestId(ids.conditions.trial)).toHaveText("Expired", { timeout: CLOCK_TIMEOUT_MS });

		await device.clock.reset();
		const refresh = screen.getByTestId(ids.conditions.refreshClock);
		await refresh.scrollTo();
		await refresh.tap();
		await expect(screen.getByTestId(ids.conditions.trial)).toHaveText("Active", { timeout: CLOCK_TIMEOUT_MS });
	});

	test("status() follows advance, a frozen set and during()", async ({ device }) => {
		await device.clock.advance("3d");
		expect(device.clock.status()).toEqual({ kind: "offset", ms: 3 * 86_400_000 });

		await device.clock.set("2030-01-01T00:00:00.000Z", { frozen: true });
		expect(device.clock.status()).toEqual({ kind: "frozen", at: "2030-01-01T00:00:00.000Z" });

		const inside = await device.clock.during("2031-06-01T00:00:00.000Z", () => device.clock.status());
		expect(inside).toEqual({ kind: "fixed", at: "2031-06-01T00:00:00.000Z" });
		expect(device.clock.status()).toEqual({ kind: "frozen", at: "2030-01-01T00:00:00.000Z" });
	});

	test("the clock showcase ticks days off the trial, expires it, and reset brings it back", async ({
		device,
		screen,
	}) => {
		await openDeepLink(device, screen, "warden-example://clock", ids.clock.screen);
		await expect(screen.getByTestId(ids.clock.trial)).toHaveText("Active");
		await expect(screen.getByTestId(ids.clock.days)).toHaveText("14");
		await expect(screen.getByTestId(ids.clock.state)).toHaveText("14 days left");

		await device.clock.advance("10d");
		await expect(screen.getByTestId(ids.clock.days)).toHaveText("4", { timeout: CLOCK_TIMEOUT_MS });
		await expect(screen.getByTestId(ids.clock.offset)).toHaveText("+10d 0h", { timeout: CLOCK_TIMEOUT_MS });

		await device.clock.advance("5d");
		await expect(screen.getByTestId(ids.clock.trial)).toHaveText("Expired", { timeout: CLOCK_TIMEOUT_MS });
		await expect(screen.getByTestId(ids.clock.state)).toHaveText("Trial expired");
		await expect(screen.getByTestId(ids.clock.days)).toHaveText("0");

		await device.clock.reset();
		await expect(screen.getByTestId(ids.clock.trial)).toHaveText("Active", { timeout: CLOCK_TIMEOUT_MS });
		await expect(screen.getByTestId(ids.clock.days)).toHaveText("14");
		await expect(screen.getByTestId(ids.clock.offset)).toHaveText("0s");
	});
});
