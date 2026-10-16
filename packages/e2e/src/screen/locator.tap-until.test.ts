import { describe, expect, test } from "bun:test";
import { el, fakeDriver, snapshotOf } from "../driver/driver.testing";
import { E2eError } from "../errors";
import type { Locator } from "./locator";
import { createScreen } from "./screen";
import { testHost } from "./screen.testing";

const WINDOW = { windowMs: 40, pollMs: 5 };

function welcome(title: string) {
	return snapshotOf([
		el("text", { id: "title", label: title, frame: { x: 24, y: 100, width: 300, height: 40 } }),
		el("button", { id: "next", label: "Next", frame: { x: 24, y: 600, width: 300, height: 44 } }),
	]);
}

/** A welcome screen whose title only changes on the `landingTap`-th press of Next (earlier presses are dropped). */
function setup(landingTap: number, options: { cache?: boolean } = {}) {
	let title = "Welcome";
	let taps = 0;
	const driver = fakeDriver({
		screens: () => welcome(title),
		onCall: (call) => {
			if (call.method === "tap") {
				taps += 1;
				if (taps >= landingTap) title = "Plan";
			}
			return undefined;
		},
	});
	const host = testHost(driver, { cache: options.cache ?? true });
	return { driver, host, screen: createScreen(host) };
}

/** What a suite's `nextStep` waits for: the title is visible and reads `title` (two reads per check). */
const titleIs = (heading: Locator, title: string) => async () =>
	(await heading.isVisible()) && (await heading.text()) === title;

async function failure(promise: Promise<unknown>): Promise<E2eError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof E2eError) return error;
		throw error;
	}
	throw new Error("did not reject");
}

describe("tap({ until })", () => {
	test("a dropped first press is sent again", async () => {
		const { driver, screen } = setup(2);
		await screen.getByTestId("next").tap({ until: titleIs(screen.getByTestId("title"), "Plan"), ...WINDOW });
		expect(driver.callsOf("tap")).toHaveLength(2);
	});

	test("a press that lands is not repeated", async () => {
		const { driver, screen } = setup(1);
		await screen.getByTestId("next").tap({ until: titleIs(screen.getByTestId("title"), "Plan"), ...WINDOW });
		expect(driver.callsOf("tap")).toHaveLength(1);
	});

	test("a locator as until counts once it is visible", async () => {
		const { driver, screen } = setup(2);
		await screen.getByTestId("next").tap({ until: screen.getByText("Plan"), ...WINDOW });
		expect(driver.callsOf("tap")).toHaveLength(2);
	});

	test("a press that never lands is sent 1 + retries times, then tap returns without throwing", async () => {
		const { driver, screen } = setup(99);
		await screen.getByTestId("next").tap({ until: screen.getByText("Plan"), ...WINDOW });
		expect(driver.callsOf("tap")).toHaveLength(3);
		const more = setup(99);
		await more.screen.getByTestId("next").tap({ until: screen.getByText("Plan"), retries: 4, ...WINDOW });
		expect(more.driver.callsOf("tap")).toHaveLength(5);
	});

	test("retries: 0 is one tap and no waiting", async () => {
		const { driver, host, screen } = setup(99);
		await screen.getByTestId("next").tap({ until: screen.getByText("Plan"), retries: 0, ...WINDOW });
		expect(driver.callsOf("tap")).toHaveLength(1);
		expect(host.clock.elapsed()).toBe(0);
	});

	test("each press gets windowMs to show its result, checked every pollMs", async () => {
		const { host, screen } = setup(99);
		await screen.getByTestId("next").tap({ until: screen.getByText("Plan"), ...WINDOW });
		expect(host.clock.elapsed()).toBe(2 * WINDOW.windowMs);
		expect(new Set(host.clock.sleeps)).toEqual(new Set([WINDOW.pollMs]));
	});

	test("the defaults are 2 retries, 4000 ms windows, 250 ms checks", async () => {
		const { driver, host, screen } = setup(99);
		await screen.getByTestId("next").tap({ until: screen.getByText("Plan") });
		expect(driver.callsOf("tap")).toHaveLength(3);
		expect(host.clock.elapsed()).toBe(8000);
		expect(new Set(host.clock.sleeps)).toEqual(new Set([250]));
	});

	test("every check is one fresh snapshot, even with two reads in it and checks closer than the cache's age limit", async () => {
		let polled = 0;
		let taps = 0;
		const driver = fakeDriver({
			screens: () => {
				polled += 1;
				return welcome(polled > 3 ? "Plan" : "Welcome");
			},
			onCall: (call) => {
				if (call.method === "tap") taps += 1;
				return undefined;
			},
		});
		const host = testHost(driver, { cache: true });
		const screen = createScreen(host);
		await screen.getByTestId("next").tap({
			until: titleIs(screen.getByTestId("title"), "Plan"),
			windowMs: 1000,
			pollMs: 5,
			retries: 1,
		});
		expect(taps).toBe(1);
		expect(driver.callsOf("snapshot")).toHaveLength(4);
		expect(host.clock.sleeps).toEqual([5, 5]);
	});

	test("a locator is checked on the snapshot of its own poll: one snapshot a check, one a press", async () => {
		const { driver, screen } = setup(99);
		await screen.getByTestId("next").tap({ until: screen.getByText("Plan"), ...WINDOW });
		const checksPerWindow = WINDOW.windowMs / WINDOW.pollMs + 1;
		expect(driver.callsOf("tap")).toHaveLength(3);
		expect(driver.callsOf("snapshot")).toHaveLength(3 + 2 * checksPerWindow);
	});

	test("a press after a check looks at the screen itself: the check's snapshot may be of a screen still moving", async () => {
		const { driver, screen } = setup(99);
		await screen.getByTestId("next").tap({ until: screen.getByText("Plan"), retries: 1, ...WINDOW });
		const checksPerWindow = WINDOW.windowMs / WINDOW.pollMs + 1;
		expect(driver.callsOf("tap")).toHaveLength(2);
		expect(driver.callsOf("snapshot")).toHaveLength(2 + checksPerWindow);
	});

	test("the check that comes right after the press sees the screen the press left", async () => {
		const { driver, screen } = setup(1);
		await screen.getByTestId("title").isVisible();
		await screen.getByTestId("next").tap({ until: screen.getByText("Plan"), ...WINDOW });
		expect(driver.callsOf("tap")).toHaveLength(1);
		expect(driver.callsOf("snapshot")).toHaveLength(3);
	});

	test("works without the observation cache too", async () => {
		const { driver, screen } = setup(2, { cache: false });
		await screen.getByTestId("next").tap({ until: titleIs(screen.getByTestId("title"), "Plan"), ...WINDOW });
		expect(driver.callsOf("tap")).toHaveLength(2);
	});

	test("is one reported step naming what it waits for", async () => {
		const { host, screen } = setup(2);
		await screen.getByTestId("next").tap({ until: screen.getByText("Plan"), ...WINDOW });
		await screen.getByTestId("next").tap({ until: async () => true });
		expect(host.steps).toEqual([
			'tap getByTestId("next") until getByText("Plan")',
			'tap getByTestId("next") until check',
		]);
	});

	test("position and timeout still apply to every press", async () => {
		const { driver, screen } = setup(99);
		await screen
			.getByTestId("next")
			.tap({ until: screen.getByText("Plan"), position: { x: 10, y: 5 }, retries: 1, ...WINDOW });
		expect(driver.callsOf("tap").map((call) => call.point)).toEqual([
			{ x: 34, y: 605 },
			{ x: 34, y: 605 },
		]);
	});

	test("a check that throws ends the tap with that error", async () => {
		const { screen } = setup(99);
		const error = await failure(
			screen.getByTestId("next").tap({
				until: async () => {
					throw new E2eError("ASSERTION", "boom");
				},
			})
		);
		expect(error.message).toBe("boom");
	});
});

describe("tap options", () => {
	test.each([
		["retries", { retries: 1 }],
		["windowMs", { windowMs: 100 }],
		["pollMs", { pollMs: 10 }],
	])("%s without until is refused", async (name, extra) => {
		const { driver, screen } = setup(1);
		const error = await failure(screen.getByTestId("next").tap(extra));
		expect(error.code).toBe("INVALID_ARGUMENT");
		expect(error.message).toContain(`"${name}"`);
		expect(driver.callsOf("tap")).toHaveLength(0);
	});

	test.each([
		["retries", { retries: -1 }],
		["retries", { retries: 1.5 }],
		["windowMs", { windowMs: 0 }],
		["pollMs", { pollMs: 0 }],
	])("a bad %s is refused before anything is pressed", async (_name, extra) => {
		const { driver, screen } = setup(1);
		const error = await failure(screen.getByTestId("next").tap({ until: screen.getByText("Plan"), ...extra }));
		expect(error.code).toBe("INVALID_ARGUMENT");
		expect(driver.callsOf("tap")).toHaveLength(0);
	});

	test("until must be a locator or a function", async () => {
		const { screen } = setup(1);
		const bad = { until: "Plan" } as unknown as Parameters<Locator["tap"]>[0];
		const error = await failure(screen.getByTestId("next").tap(bad));
		expect(error.code).toBe("INVALID_ARGUMENT");
	});

	test("an unknown option is still refused", async () => {
		const { screen } = setup(1);
		const bad = { retry: 2 } as unknown as Parameters<Locator["tap"]>[0];
		const error = await failure(screen.getByTestId("next").tap(bad));
		expect(error.message).toContain('"retry"');
	});
});
