import { describe, expect, test } from "bun:test";
import type { Device } from "@delacour/warden-e2e";
import { el, type FakeDriver, fakeDriver, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import { createScreen } from "@delacour/warden-e2e/screen/screen";
import { staticDriver, testHost } from "@delacour/warden-e2e/screen/screen.testing";
import { expectTodosAfterSignIn, FLOW_OPTIONS, launch, nextStep, openDeepLink } from "./flows";
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
	return { driver, screen: createScreen(testHost(driver, { cache: true })) };
}

describe("FLOW_OPTIONS", () => {
	test("the flow opens the app itself and system sheets are dismissed", () => {
		expect(FLOW_OPTIONS).toEqual({ launch: "none", systemAlerts: "dismiss" });
	});
});

describe("launch", () => {
	test("opens the app and waits for it to be in front and still, then for the welcome screen", async () => {
		const opened: unknown[] = [];
		const driver = staticDriver([el("other", { id: ids.welcome.screen })]);
		const screen = createScreen(testHost(driver));
		await launch({ open: async (options) => void opened.push(options) }, screen);
		expect(opened).toEqual([{ wait: "quiet" }]);
	});

	test("fails when the welcome screen never shows", async () => {
		const screen = createScreen(testHost(staticDriver([]), { actionTimeoutMs: 100, assertionTimeoutMs: 100 }));
		await expect(launch({ open: async () => undefined }, screen)).rejects.toThrow();
	});
});

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

	test("sends the press at most 3 times, then the title assertion says what is missing", async () => {
		const { driver, screen } = setup(99);
		await expect(nextStep(screen, "Plan", OPTIONS)).rejects.toThrow();
		expect(driver.callsOf("tap")).toHaveLength(3);
	});

	test("a title that merely contains the step name does not count", async () => {
		let taps = 0;
		const driver = fakeDriver({
			screens: () => welcome("Plan B"),
			onCall: (call) => {
				if (call.method === "tap") taps += 1;
				return undefined;
			},
		});
		const screen = createScreen(testHost(driver, { cache: true }));
		await expect(nextStep(screen, "Plan", OPTIONS)).rejects.toThrow();
		expect(taps).toBe(3);
	});
});

describe("expectTodosAfterSignIn", () => {
	function behindSheet() {
		let sheetUp = true;
		const driver = fakeDriver({
			screens: () =>
				sheetUp ? snapshotOf([], { modal: { pid: 7 } }) : snapshotOf([el("other", { id: ids.todos.screen })]),
		});
		const host = testHost(driver, { cache: true });
		const answered: number[] = [];
		host.answerSystemAlert = async () => {
			answered.push(1);
			sheetUp = false;
			return true;
		};
		return { screen: createScreen(host), answered };
	}

	test("returns once the todos screen shows", async () => {
		const screen = createScreen(testHost(staticDriver([el("other", { id: ids.todos.screen })])));
		await expectTodosAfterSignIn(screen);
	});

	test("dismisses a sheet that covers the app while it waits", async () => {
		const { screen, answered } = behindSheet();
		await expectTodosAfterSignIn(screen);
		expect(answered).toHaveLength(1);
	});

	test("fails when the todos screen never shows", async () => {
		const screen = createScreen(testHost(staticDriver([])));
		await expect(expectTodosAfterSignIn(screen)).rejects.toThrow();
	});
});

describe("openDeepLink", () => {
	/** A device whose `openLink` shows the detail screen from its `landingOpen`-th call on (earlier links are dropped). */
	function linking(landingOpen: number) {
		let shown = false;
		const driver = fakeDriver({
			screens: () => snapshotOf(shown ? [el("other", { id: ids.detail.title })] : []),
		});
		const opens: { url: string; waitMs: number | undefined }[] = [];
		const device: Pick<Device, "openLink"> = {
			openLink: async (url, options) => {
				opens.push({ url, waitMs: options?.waitMs });
				if (opens.length >= landingOpen) shown = true;
			},
		};
		return { device, opens, screen: createScreen(testHost(driver)) };
	}

	test("one link is enough when the screen shows", async () => {
		const { device, opens, screen } = linking(1);
		await openDeepLink(device, screen, "warden-example://todo/1", ids.detail.title);
		expect(opens).toEqual([{ url: "warden-example://todo/1", waitMs: 6_000 }]);
	});

	test("opens the link again when the screen did not show", async () => {
		const { device, opens, screen } = linking(2);
		await openDeepLink(device, screen, "warden-example://todo/1", ids.detail.title);
		expect(opens).toHaveLength(2);
	});

	test("gives up after 3 links without an error: the next assertion reports the screen", async () => {
		const { device, opens, screen } = linking(99);
		await openDeepLink(device, screen, "warden-example://todo/1", ids.detail.title);
		expect(opens).toHaveLength(3);
	});
});
