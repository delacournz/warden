import { describe, expect, test } from "bun:test";
import { ANDROID_SETTINGS, snapshotOf as a11ySnapshot, IOS_SETTINGS } from "../a11y/a11y.fixture";
import { announce } from "../a11y/speech";
import { fakeDriver } from "../driver/driver.testing";
import type { Snapshot } from "../driver/driver.types";
import type { E2eError } from "../errors";
import { createScreen } from "../screen/screen";
import { testHost } from "../screen/screen.testing";
import { LocatorAssertions } from "./matchers";

async function failure(promise: Promise<unknown>): Promise<E2eError> {
	try {
		await promise;
	} catch (error) {
		return error as E2eError;
	}
	throw new Error("did not reject");
}

function setup(snapshot: Snapshot, extra: Partial<Parameters<typeof fakeDriver>[0]> = {}) {
	const driver = fakeDriver({ screens: [snapshot], platform: snapshot.platform, ...extra });
	const host = testHost(driver, { assertionTimeoutMs: 300 });
	const screen = createScreen(host);
	const that = (locator: ReturnType<typeof screen.getByTestId>) => new LocatorAssertions(locator, { negate: false });
	return { driver, host, screen, that };
}

const NOTIFICATIONS = "settings-notifications";

describe("toHaveAccessibleName", () => {
	test("matches the computed name exactly, or by RegExp", async () => {
		const { screen, that } = setup(IOS_SETTINGS);
		await that(screen.getByTestId(NOTIFICATIONS)).toHaveAccessibleName("Notifications");
		await that(screen.getByTestId(NOTIFICATIONS)).toHaveAccessibleName(/^notif/i);
	});

	test("an Android node's name comes from its text", async () => {
		const snapshot = a11ySnapshot("android", [
			{ role: "button", text: "Save", identifier: "save", traits: ["clickable"] },
		]);
		const { screen, that } = setup(snapshot);
		await that(screen.getByTestId("save")).toHaveAccessibleName("Save");
	});

	test("a mismatch fails with the received name and the --a11y screen", async () => {
		const { screen, that } = setup(IOS_SETTINGS);
		const error = await failure(that(screen.getByTestId(NOTIFICATIONS)).toHaveAccessibleName("Alerts"));
		expect(error.code).toBe("ASSERTION");
		expect(error.message).toContain('toHaveAccessibleName("Alerts")');
		expect(error.message).toContain('Received: "Notifications"');
		expect(error.screen).toContain('hint="Double tap to toggle"');
	});

	test(".not inverts it", async () => {
		const { screen } = setup(IOS_SETTINGS);
		await new LocatorAssertions(screen.getByTestId(NOTIFICATIONS), { negate: true }).toHaveAccessibleName("Alerts");
	});
});

describe("toHaveRole", () => {
	test("uses the getByRole vocabulary", async () => {
		const { screen, that } = setup(IOS_SETTINGS);
		await that(screen.getByTestId(NOTIFICATIONS)).toHaveRole("switch");
		const error = await failure(that(screen.getByTestId(NOTIFICATIONS)).toHaveRole("button"));
		expect(error.message).toContain('Received: "switch"');
	});
});

describe("toHaveHint", () => {
	test("matches the hint the snapshot carries", async () => {
		const { screen, that } = setup(IOS_SETTINGS);
		await that(screen.getByTestId(NOTIFICATIONS)).toHaveHint("Double tap to toggle");
		await that(screen.getByTestId(NOTIFICATIONS)).toHaveHint(/toggle$/);
	});

	test("a node without a hint fails with (no hint)", async () => {
		const { screen, that } = setup(IOS_SETTINGS);
		const error = await failure(that(screen.getByTestId("settings-name")).toHaveHint("Anything"));
		expect(error.message).toContain("Received: (no hint)");
	});

	test("iOS hints come from the injected read when the driver offers it", async () => {
		const plain = a11ySnapshot("ios", [{ role: "button", label: "Pay", identifier: "pay", traits: ["button"] }]);
		const readA11y = (shot: Snapshot): Snapshot => {
			for (const element of shot.flat) if (element.identifier === "pay") element.a11y = { hint: "Charges your card" };
			return shot;
		};
		const { screen, that, driver } = setup(plain, { readA11y });
		await that(screen.getByTestId("pay")).toHaveHint("Charges your card");
		expect(driver.callsOf("readA11y").length).toBeGreaterThan(0);
	});

	test("a read the app was launched without (E_UNSUPPORTED) leaves the plain snapshot", async () => {
		const plain = a11ySnapshot("ios", [{ role: "button", label: "Pay", identifier: "pay", traits: ["button"] }]);
		const { screen, that } = setup(plain, {
			readA11y: () => plain,
			onCall: (call) =>
				call.method === "readA11y"
					? { error: { code: "E_UNSUPPORTED", message: "no inject", retryable: false } }
					: undefined,
		});
		await that(screen.getByTestId("pay")).toHaveAccessibleName("Pay");
	});
});

describe("toAnnounce", () => {
	test("matches the speech model's phrase", async () => {
		const { screen, that } = setup(IOS_SETTINGS);
		const notifications = IOS_SETTINGS.flat.find((e) => e.identifier === NOTIFICATIONS);
		if (!notifications) throw new Error("fixture");
		const phrase = announce(notifications, "ios").text;
		await that(screen.getByTestId(NOTIFICATIONS)).toAnnounce(phrase);
		await that(screen.getByTestId(NOTIFICATIONS)).toAnnounce(/^Notifications,/);
		await that(screen.getByTestId(NOTIFICATIONS)).toAnnounce("notifications", { exact: false });
	});

	test("a different phrase fails and names what would be said", async () => {
		const { screen, that } = setup(IOS_SETTINGS);
		const error = await failure(that(screen.getByTestId(NOTIFICATIONS)).toAnnounce("Nothing"));
		expect(error.message).toContain("toAnnounce(");
		expect(error.message).toContain('Received: "Notifications');
	});
});

describe("toBeA11yFocused", () => {
	const focused = (on: boolean) =>
		a11ySnapshot("android", [
			{ role: "button", text: "Go", identifier: "go", traits: ["clickable"], a11y: { a11yFocused: on } },
		]);

	test("passes on the node holding accessibility focus", async () => {
		const { screen, that } = setup(focused(true));
		await that(screen.getByTestId("go")).toBeA11yFocused();
	});

	test("fails on a node without it, and .not passes", async () => {
		const { screen, that } = setup(focused(false));
		const error = await failure(that(screen.getByTestId("go")).toBeA11yFocused());
		expect(error.message).toContain("Received: not a11y-focused");
		await new LocatorAssertions(screen.getByTestId("go"), { negate: true }).toBeA11yFocused();
	});

	test("Android settings fixture has no focus", async () => {
		const { screen } = setup(ANDROID_SETTINGS);
		await new LocatorAssertions(screen.getByTestId("settings-avatar"), { negate: true }).toBeA11yFocused();
	});
});
