import { describe, expect, test } from "bun:test";
import { el, type FakeDriver, fakeDriver, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import { createScreen } from "@delacour/warden-e2e/screen/screen";
import { testHost } from "@delacour/warden-e2e/screen/screen.testing";
import { nextStep } from "./flows";
import { ids } from "./ids";

const OPTIONS = { windowMs: 40, pollMs: 5 };

function welcome(title: string) {
	return snapshotOf([
		el("text", { id: ids.welcome.title, label: title, frame: { x: 24, y: 100, width: 300, height: 40 } }),
		el("button", { id: ids.welcome.next, label: "Next", frame: { x: 24, y: 600, width: 300, height: 44 } }),
	]);
}

/** A welcome screen whose title only changes on the `landingTap`-th press of Next (earlier presses are dropped). */
function setup(landingTap: number): { driver: FakeDriver; screen: ReturnType<typeof createScreen> } {
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
	return { driver, screen: createScreen(testHost(driver)) };
}

describe("nextStep", () => {
	test("re-sends the press when the first one was dropped", async () => {
		const { driver, screen } = setup(2);
		await nextStep(screen, "Plan", OPTIONS);
		expect(driver.callsOf("tap")).toHaveLength(2);
	});

	test("taps once when the first press lands", async () => {
		const { driver, screen } = setup(1);
		await nextStep(screen, "Plan", OPTIONS);
		expect(driver.callsOf("tap")).toHaveLength(1);
	});
});
