import { beforeAll, describe, expect, type Screen, test } from "@delacour/warden-e2e";
import { ENV_NAMES } from "@delacour/warden-e2e/env";
import { ids } from "../helpers/ids";
import { openKeyboardSheet, SPEC_OPTIONS } from "../helpers/steps";

test.use(SPEC_OPTIONS);

/** Far enough that a keyboard, not layout noise, moved the footer: well under any phone keyboard's height. */
const MIN_LIFT = 100;

/**
 * Android's hardware mode is still being fixed (the live switch is not reliable yet), so the toggle test runs on iOS
 * only for now. The first test covers the software keyboard on both platforms.
 */
const toggleTest = test.skipIf(process.env[ENV_NAMES.platform] === "android");

/** Opens the sheet and types the note, leaving the field focused so the keyboard is up (software mode). */
async function openAndType(screen: Screen, note = "Buy milk"): Promise<void> {
	await screen.getByTestId(ids.keyboardSheet.open).tap({ until: screen.getByTestId(ids.keyboardSheet.input) });
	await screen.getByTestId(ids.keyboardSheet.input).fill(note);
}

/**
 * Presses Save until the sheet closes. After a keyboard change the footer is still sliding, and a press on a moving
 * button can be dropped, so a press that closed nothing is sent again.
 */
async function saveNote(screen: Screen): Promise<void> {
	const save = screen.getByTestId(ids.keyboardSheet.save);
	await save.tap({ until: async () => !(await save.isVisible()) });
}

/** The keyboard sheet on one launch: the second test reopens the sheet the first one saved and closed. */
describe.serial("keyboard sheet", () => {
	beforeAll(async ({ app, device, screen }) => {
		await openKeyboardSheet(app, device, screen);
	});

	test("with the software keyboard up the sheet's Save footer stays reachable and saves", async ({
		device,
		screen,
	}) => {
		await expect(screen.getByTestId(ids.keyboardSheet.saved)).toHaveText("none");

		await openAndType(screen);
		await expect(device).toHaveKeyboard();
		await expect(screen.getByTestId(ids.keyboardSheet.save)).toBeVisible();

		await saveNote(screen);
		await expect(screen.getByTestId(ids.keyboardSheet.saved)).toHaveText("Buy milk");
		await expect(screen.getByTestId(ids.keyboardSheet.save)).toBeHidden();
	});

	toggleTest(
		"switching to the hardware keyboard drops the keyboard and the footer settles back",
		async ({ device, screen }) => {
			await openAndType(screen, "Buy bread");
			await expect(device).toHaveKeyboard();
			await device.settle();
			const lifted = await screen.getByTestId(ids.keyboardSheet.save).boundingBox();

			await device.keyboard("hardware");
			await expect(device).not.toHaveKeyboard();
			await expect(screen.getByTestId(ids.keyboardSheet.save)).toBeVisible();
			await device.settle();
			const settled = await screen.getByTestId(ids.keyboardSheet.save).boundingBox();
			expect(settled.y - lifted.y).toBeGreaterThan(MIN_LIFT);

			await saveNote(screen);
			await expect(screen.getByTestId(ids.keyboardSheet.saved)).toHaveText("Buy bread");

			await device.keyboard("software");
			await screen.getByTestId(ids.keyboardSheet.open).tap({ until: screen.getByTestId(ids.keyboardSheet.input) });
			await screen.getByTestId(ids.keyboardSheet.input).tap();
			await expect(device).toHaveKeyboard();
			await expect(screen.getByTestId(ids.keyboardSheet.save)).toBeVisible();
		}
	);
});
