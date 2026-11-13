import { beforeAll, describe, expect, test } from "@delacour/warden-e2e";
import { ids } from "../helpers/ids";
import { openSettingsTab, SPEC_OPTIONS, signedIn } from "../helpers/steps";

test.use(SPEC_OPTIONS);

/**
 * Locator and screen actions on one sign-in: text entry on the todos field, keys, a coordinate tap, then scrolling
 * on Settings. Each test leaves the screen the next one starts from.
 */
describe.serial("framework: actions", () => {
	beforeAll(async ({ app, screen }) => {
		await signedIn(app, screen);
	});

	test("fill replaces what the field holds", async ({ screen }) => {
		const input = screen.getByTestId(ids.todos.input);
		await input.fill("First draft");
		await input.fill("Buy");
		await expect(input).toHaveValue("Buy");
	});

	test("type adds at the caret", async ({ screen }) => {
		const input = screen.getByTestId(ids.todos.input);
		await input.type(" milk");
		await expect(input).toHaveValue("Buy milk");
	});

	test("press sends keys: Backspace deletes one character", async ({ screen }) => {
		const input = screen.getByTestId(ids.todos.input);
		await input.press("Backspace");
		await expect(input).toHaveValue("Buy mil");
		await input.type("k");
		await expect(input).toHaveValue("Buy milk");
	});

	test("press Enter submits the field (onSubmitEditing adds the todo)", async ({ screen }) => {
		await screen.getByTestId(ids.todos.input).press("Enter");
		await expect(screen.getByTestId(ids.todos.title("todo-1"))).toHaveText("Buy milk");
		await expect(screen.getByTestId(ids.todos.remaining)).toHaveText("2 left");
	});

	test("clear empties the field", async ({ screen }) => {
		const input = screen.getByTestId(ids.todos.input);
		await input.fill("To be cleared");
		await input.clear();
		await expect(screen.getByTestId(ids.todos.add)).toBeDisabled();
	});

	test("clear on a field that is already empty (it reads as its placeholder) passes and leaves it empty", async ({
		screen,
	}) => {
		await screen.getByTestId(ids.todos.input).clear();
		await expect(screen.getByTestId(ids.todos.add)).toBeDisabled();
	});

	test("hideKeyboard puts the keyboard away", async ({ device, screen }) => {
		await screen.getByTestId(ids.todos.input).tap();
		await expect(device).toHaveKeyboard();
		await device.hideKeyboard();
		await expect(device).not.toHaveKeyboard();
	});

	test("tapAt presses a point: the centre of the Done filter", async ({ screen }) => {
		const done = await screen.getByTestId(ids.todos.filter("done")).boundingBox();
		await screen.tapAt({ x: done.x + done.width / 2, y: done.y + done.height / 2 });
		await expect(screen.getByTestId(ids.todos.row("welcome"))).toBeHidden();
		await expect(screen.getByTestId(ids.todos.row("warden"))).toBeVisible();
	});

	test("tap with a function until re-reads the screen until it holds", async ({ screen }) => {
		const all = screen.getByTestId(ids.todos.filter("all"));
		const welcomeRow = screen.getByTestId(ids.todos.row("welcome"));
		await all.tap({ until: async () => (await welcomeRow.read()).visible });
		await expect(welcomeRow).toBeVisible();
	});

	test("scrollTo brings a row below the fold into view, and back up", async ({ screen }) => {
		await openSettingsTab(screen);
		const clock = screen.getByTestId(ids.settings.clock);
		await clock.scrollTo();
		await expect(clock).toBeVisible();
		const email = screen.getByTestId(ids.settings.email);
		await email.scrollTo({ direction: "up" });
		await expect(email).toBeVisible();
	});

	test("screen.scrollUntilVisible scrolls the screen until the locator shows", async ({ screen }) => {
		const clock = screen.getByTestId(ids.settings.clock);
		await screen.scrollUntilVisible(clock);
		await expect(clock).toBeVisible();
		await screen.scrollUntilVisible(screen.getByTestId(ids.settings.email), { direction: "up" });
		await expect(screen.getByTestId(ids.settings.email)).toBeVisible();
	});
});
