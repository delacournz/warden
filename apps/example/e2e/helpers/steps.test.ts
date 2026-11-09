import { describe, expect, test } from "bun:test";
import type { Device } from "@delacour/warden-e2e";
import { el, type FakeDriver, fakeDriver, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import { createScreen } from "@delacour/warden-e2e/screen/screen";
import { staticDriver, testHost } from "@delacour/warden-e2e/screen/screen.testing";
import { ids } from "./ids";
import { expectTodosAfterSignIn, launch, nextStep, openDeepLink, revealAbove, SPEC_OPTIONS, signOut } from "./steps";

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

describe("SPEC_OPTIONS", () => {
	test("the spec opens the app itself and system sheets are dismissed", () => {
		expect(SPEC_OPTIONS).toEqual({ launch: "none", systemAlerts: "dismiss" });
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

describe("signOut", () => {
	const TAB = { x: 300, y: 800, width: 80, height: 40 };
	const SIGN_OUT = { x: 24, y: 600, width: 300, height: 44 };

	/** Tabs → Settings (on a tap of the tab) → welcome (on the `landingSignOut`-th tap of Sign out). */
	function tabs(landingSignOut: number) {
		let at: "todos" | "settings" | "welcome" = "todos";
		let signOutTaps = 0;
		const inside = (point: { x: number; y: number }, r: typeof TAB) =>
			point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height;
		const press = (point: { x: number; y: number }): void => {
			if (at === "welcome") return;
			if (inside(point, TAB)) at = "settings";
			else if (at === "settings" && inside(point, SIGN_OUT)) {
				signOutTaps += 1;
				if (signOutTaps >= landingSignOut) at = "welcome";
			}
		};
		const driver = fakeDriver({
			screens: () => {
				if (at === "welcome") return snapshotOf([el("other", { id: ids.welcome.screen })]);
				const tab = el("button", { id: ids.tabs.settings, label: "Settings", frame: TAB });
				if (at === "todos") return snapshotOf([el("other", { id: ids.todos.screen }), tab]);
				return snapshotOf([
					el("other", { id: ids.settings.screen }),
					el("text", { id: ids.settings.email, label: "ada@example.com" }),
					el("button", { id: ids.settings.signOut, label: "Sign out", frame: SIGN_OUT }),
					tab,
				]);
			},
			onCall: (call) => {
				if (call.method === "tap") press(call.point);
				return undefined;
			},
		});
		return { driver, screen: createScreen(testHost(driver, { cache: true })), taps: () => signOutTaps };
	}

	test("opens Settings, presses Sign out and waits for the welcome screen", async () => {
		const { screen, taps } = tabs(1);
		await signOut(screen);
		expect(taps()).toBe(1);
	});

	test("re-sends a dropped Sign out press", async () => {
		const { screen, taps } = tabs(2);
		await signOut(screen);
		expect(taps()).toBe(2);
	});
});

describe("revealAbove", () => {
	const FOOTER = { x: 20, y: 693, width: 362, height: 52 };

	/** A row at `top` that each swipe moves by the swipe's own distance (a drag with no fling), under a fixed footer. */
	function list(top: number) {
		let y = top;
		const driver = fakeDriver({
			screens: () =>
				snapshotOf([
					el("button", { id: "row", label: "Row", frame: { x: 21, y, width: 360, height: 56 } }),
					el("button", { id: "footer", label: "Sign out", frame: FOOTER }),
				]),
			onCall: (call) => {
				if (call.method === "swipe") y += call.to.y - call.from.y;
				return undefined;
			},
		});
		const screen = createScreen(testHost(driver));
		return { driver, screen, top: () => y };
	}

	test("does nothing when the row is already clear of the footer", async () => {
		const { driver, screen } = list(400);
		await revealAbove(screen, screen.getByTestId("row"), screen.getByTestId("footer"));
		expect(driver.callsOf("swipe")).toHaveLength(0);
	});

	test("drags a row the footer covers up until its bottom edge is above the footer", async () => {
		const { driver, screen, top } = list(686);
		await revealAbove(screen, screen.getByTestId("row"), screen.getByTestId("footer"));
		expect(driver.callsOf("swipe").length).toBeGreaterThan(0);
		expect(top() + 56).toBeLessThanOrEqual(FOOTER.y);
	});

	test("gives up after 4 drags on a list that does not move", async () => {
		const driver = fakeDriver({
			screens: () =>
				snapshotOf([
					el("button", { id: "row", label: "Row", frame: { x: 21, y: 686, width: 360, height: 56 } }),
					el("button", { id: "footer", label: "Sign out", frame: FOOTER }),
				]),
		});
		const screen = createScreen(testHost(driver));
		await revealAbove(screen, screen.getByTestId("row"), screen.getByTestId("footer"));
		expect(driver.callsOf("swipe")).toHaveLength(4);
	});
});
