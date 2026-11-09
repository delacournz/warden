import { beforeAll, describe, expect, test } from "@delacour/warden-e2e";
import { ids } from "../helpers/ids";
import { openSettingsTab, openTodosTab, revealAbove, SPEC_OPTIONS, signedIn, signOut } from "../helpers/steps";

test.use(SPEC_OPTIONS);

/** A Settings row that pushes a screen, and the ids of that screen and its Back button. */
type Row = { name: string; row: string; screen: string; back: string };

/** Every row that pushes a screen, top to bottom as Settings lists them. */
const ROWS: readonly Row[] = [
	{ name: "Gesture playground", row: ids.settings.gestures, screen: ids.gestures.screen, back: ids.gestures.back },
	{ name: "Conditions", row: ids.settings.conditions, screen: ids.conditions.screen, back: ids.conditions.back },
	{
		name: "Keyboard sheet",
		row: ids.settings.keyboardSheet,
		screen: ids.keyboardSheet.screen,
		back: ids.keyboardSheet.back,
	},
	{ name: "Accessibility", row: ids.settings.a11y, screen: ids.a11y.screen, back: ids.a11y.back },
	{ name: "Camera", row: ids.settings.camera, screen: ids.camera.screen, back: ids.camera.back },
	{ name: "Biometrics", row: ids.settings.biometrics, screen: ids.biometrics.screen, back: ids.biometrics.back },
	{ name: "Network", row: ids.settings.network, screen: ids.network.screen, back: ids.network.back },
	{ name: "Location", row: ids.settings.location, screen: ids.location.screen, back: ids.location.back },
	{ name: "Clock", row: ids.settings.clock, screen: ids.clock.screen, back: ids.clock.back },
];

/**
 * Settings on one sign-in: the account, both switches, every row that pushes a screen (in and Back out again) and
 * sign out. A row test starts and ends on Settings, so they can run in any order.
 */
describe.serial("settings", () => {
	beforeAll(async ({ app, screen }) => {
		await signedIn(app, screen, "grace@example.com");
	});

	test("shows the signed-in account", async ({ screen }) => {
		await openSettingsTab(screen);
		await expect(screen.getByTestId(ids.settings.email)).toHaveText("grace@example.com");
	});

	test("the notifications switch turns off and on", async ({ screen }) => {
		const notifications = screen.getByTestId(ids.settings.notifications);
		await expect(notifications).toBeChecked();
		await notifications.tap();
		await expect(notifications).toBeChecked({ checked: false });
		await notifications.tap();
		await expect(notifications).toBeChecked();
	});

	test("the dark mode switch turns on and off", async ({ screen }) => {
		const darkMode = screen.getByTestId(ids.settings.darkMode);
		await expect(darkMode).toBeChecked({ checked: false });
		await darkMode.tap();
		await expect(darkMode).toBeChecked();
		await darkMode.tap();
		await expect(darkMode).toBeChecked({ checked: false });
	});

	/**
	 * Settings stays in the tree under a pushed screen, so "Settings is visible" says nothing about the Back press: the
	 * pushed screen leaving does. The sticky Sign out footer floats over the last rows, so a row is first dragged clear of
	 * it (`revealAbove`): the tree would call a covered row visible and the tap would sign out. A row test ends on a still Settings screen, because a press that lands while the
	 * pop is still sliding is dropped, and the moving frames look to `tap({ until })` like a reaction to it.
	 */
	for (const { name, row, screen: target, back } of ROWS) {
		test(`${name} opens and Back returns to Settings`, async ({ device, screen }) => {
			const pushed = screen.getByTestId(target);
			const entry = screen.getByTestId(row);
			await entry.scrollTo();
			await revealAbove(screen, entry, screen.getByTestId(ids.settings.signOut));
			await entry.tap({ until: pushed });
			await expect(pushed).toBeVisible();
			await screen.getByTestId(back).tap({ until: async () => !(await pushed.isVisible()) });
			await expect(pushed).toBeHidden();
			await device.settle();
			await expect(screen.getByTestId(ids.settings.screen)).toBeVisible();
		});
	}

	test("Settings keeps its switch state across a tab round trip", async ({ screen }) => {
		const notifications = screen.getByTestId(ids.settings.notifications);
		await notifications.scrollTo({ direction: "up" });
		await notifications.tap({ until: async () => (await notifications.read()).checked === false });
		await expect(notifications).toBeChecked({ checked: false });

		await openTodosTab(screen);
		await openSettingsTab(screen);
		await expect(notifications).toBeChecked({ checked: false });
	});

	test("signing out returns to the welcome screen", async ({ screen }) => {
		await signOut(screen);
	});
});
