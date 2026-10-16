import { describe, expect, test } from "bun:test";
import { el, failWith, fakeDriver, snapshotOf } from "../driver/driver.testing";
import { OBSERVATION_MAX_AGE_MS } from "../driver/observation-cache";
import { LocatorAssertions } from "../expect/matchers";
import { FIELD_POLL_MS, STALE_RISK_READS } from "./field";
import type { Locator } from "./locator";
import { createScreen } from "./screen";
import { staticDriver, testHost } from "./screen.testing";

const expectLocator = (locator: Locator): LocatorAssertions => new LocatorAssertions(locator, { negate: false });

/** Two nodes on a screen that never changes, behind the observation cache and a fake clock. */
function setup(platform: "ios" | "android" = "ios") {
	const driver = staticDriver(
		[
			el("text", { id: "title", label: "Plan" }),
			el("button", { id: "next", label: "Next", hittable: true }),
			el("button", { id: "skip", label: "Skip", hittable: true }),
		],
		platform
	);
	const host = testHost(driver, { cache: true });
	return { driver, host, screen: createScreen(host) };
}

const snapshots = (driver: ReturnType<typeof setup>["driver"]): number => driver.callsOf("snapshot").length;

describe("reads that follow each other", () => {
	test("isVisible then text take one snapshot", async () => {
		const { driver, screen } = setup();
		const title = screen.getByTestId("title");
		expect(await title.isVisible()).toBe(true);
		expect(await title.text()).toBe("Plan");
		expect(snapshots(driver)).toBe(1);
	});

	test("reads of different locators share it too", async () => {
		const { driver, screen } = setup();
		await screen.getByTestId("title").text();
		await screen.getByTestId("next").isVisible();
		await screen.getByTestId("skip").isEnabled();
		expect(snapshots(driver)).toBe(1);
	});

	test("a tap between them makes it two", async () => {
		const { driver, screen } = setup();
		const title = screen.getByTestId("title");
		await title.isVisible();
		await screen.getByTestId("next").tap();
		await title.text();
		expect(snapshots(driver)).toBe(2);
	});

	test.each([
		["tapAt", (s: ReturnType<typeof setup>["screen"]) => s.tapAt({ x: 5, y: 5 })],
		["swipe", (s: ReturnType<typeof setup>["screen"]) => s.swipe({ from: { x: 1, y: 1 }, to: { x: 1, y: 9 } })],
	])("%s counts as input", async (_name, act) => {
		const { driver, screen } = setup();
		await screen.getByTestId("title").isVisible();
		await act(screen);
		await screen.getByTestId("title").isVisible();
		expect(snapshots(driver)).toBe(2);
	});

	test("a device call that moves the screen (a hardware button) counts as input", async () => {
		const { driver, host, screen } = setup();
		await screen.getByTestId("title").isVisible();
		await (await host.driver()).pressButton("home");
		await screen.getByTestId("title").isVisible();
		expect(snapshots(driver)).toBe(2);
	});

	test.each([
		["ios", 150],
		["android", 1000],
	] as const)("%s: a read that comes %d ms after the last one takes a new snapshot", async (platform, maxAge) => {
		expect(OBSERVATION_MAX_AGE_MS[platform]).toBe(maxAge);
		const { driver, host, screen } = setup(platform);
		const title = screen.getByTestId("title");
		await title.isVisible();
		host.clock.advance(maxAge - 1);
		await title.text();
		expect(snapshots(driver)).toBe(1);
		host.clock.advance(1);
		await title.text();
		expect(snapshots(driver)).toBe(2);
	});

	test("without the cache every read is its own snapshot, as before", async () => {
		const driver = staticDriver([el("text", { id: "title", label: "Plan" })]);
		const screen = createScreen(testHost(driver));
		const title = screen.getByTestId("title");
		await title.isVisible();
		await title.text();
		expect(snapshots(driver)).toBe(2);
	});
});

describe("assertions and actions", () => {
	test("two assertions in a row take one snapshot", async () => {
		const { driver, screen } = setup();
		await expectLocator(screen.getByTestId("title")).toBeVisible();
		await expectLocator(screen.getByTestId("title")).toHaveText("Plan");
		expect(snapshots(driver)).toBe(1);
	});

	test("a tap on what an assertion just saw does not look again", async () => {
		const { driver, screen } = setup();
		await expectLocator(screen.getByTestId("next")).toBeVisible();
		await screen.getByTestId("next").tap();
		expect(snapshots(driver)).toBe(1);
		expect(driver.callsOf("tap")).toHaveLength(1);
	});

	test("the assertion after a tap looks at the screen the tap left", async () => {
		const { driver, screen } = setup();
		await screen.getByTestId("next").tap();
		await expectLocator(screen.getByTestId("title")).toBeVisible();
		expect(snapshots(driver)).toBe(2);
	});
});

describe("only the first poll of a wait may reuse", () => {
	function lateScreen() {
		let shown = false;
		const driver = fakeDriver({
			screens: () => snapshotOf(shown ? [el("text", { id: "late", label: "Late" })] : []),
		});
		const host = testHost(driver, { cache: true });
		const show = () => {
			shown = true;
		};
		return { driver, host, screen: createScreen(host), show };
	}

	test("waitFor: the first poll takes the kept snapshot, the second reads the device", async () => {
		const { driver, host, screen, show } = lateScreen();
		expect(await screen.getByTestId("late").isVisible()).toBe(false);
		show();
		await screen.getByTestId("late").waitFor();
		expect(driver.callsOf("snapshot")).toHaveLength(2);
		expect(host.clock.sleeps).toEqual([100]);
	});

	test("an assertion that is not met on the kept snapshot is met on the next, fresh one", async () => {
		const { driver, screen, show } = lateScreen();
		await screen.getByTestId("late").isVisible();
		show();
		await expectLocator(screen.getByTestId("late")).toBeVisible();
		expect(driver.callsOf("snapshot")).toHaveLength(2);
	});
});

describe("field confirm reads", () => {
	test("never come from the kept snapshot: each one is a read of the device", async () => {
		const driver = fakeDriver({
			screens: () => snapshotOf([el("textfield", { id: "field", label: "Email", value: "a@b.co" })]),
			onCall: (call) => (call.method === "elementAtPoint" ? { data: null } : undefined),
		});
		const host = testHost(driver, { cache: true });
		await createScreen(host).getByTestId("field").fill("a@b.co");
		const reads = driver.callsOf("elementAtPoint").length;
		expect(reads).toBe(STALE_RISK_READS);
		expect(driver.callsOf("snapshot")).toHaveLength(1 + STALE_RISK_READS);
		expect(host.clock.sleeps.filter((ms) => ms === FIELD_POLL_MS).length).toBe(STALE_RISK_READS - 1);
	});

	test("a hit-test is a driver call of its own, never answered from a snapshot", async () => {
		const driver = fakeDriver({
			screens: () => snapshotOf([el("textfield", { id: "field", label: "Email", value: "" })]),
		});
		const host = testHost(driver, { cache: true });
		await createScreen(host).getByTestId("field").isVisible();
		const seen = await host.driver();
		await seen.elementAtPoint({ x: 10, y: 10 });
		await seen.elementAtPoint({ x: 10, y: 10 });
		expect(driver.callsOf("elementAtPoint")).toHaveLength(2);
	});
});

describe("a failed read", () => {
	test("is not kept: the next read tries the device again", async () => {
		let fail = true;
		const driver = fakeDriver({
			screens: () => snapshotOf([el("text", { id: "title", label: "Plan" })]),
			onCall: (call) => (call.method === "snapshot" && fail ? failWith("E_AX_UNAVAILABLE") : undefined),
		});
		const host = testHost(driver, { cache: true });
		const screen = createScreen(host);
		await expect(screen.getByTestId("title").isVisible()).rejects.toThrow();
		fail = false;
		expect(await screen.getByTestId("title").isVisible()).toBe(true);
	});
});
