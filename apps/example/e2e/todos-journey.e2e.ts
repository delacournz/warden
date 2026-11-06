import { afterAll, beforeAll, describe, expect, test } from "@delacour/warden-e2e";
import { ids } from "./helpers/ids";
import { SPEC_OPTIONS, signedIn } from "./helpers/steps";

test.use(SPEC_OPTIONS);

/**
 * One launch and one sign-in for several checks: `describe.serial` keeps the app open between the tests, so each test
 * starts where the one before it stopped, and once one fails the rest are reported `skipped`. `beforeAll` signs in
 * (`SPEC_OPTIONS` has `launch: "none"`, so `signedIn` does the one launch itself); `afterAll` signs out again.
 * Each test still gets its own `{ screen }`, deadline, steps and failure artifacts.
 */
describe.serial("signed-in journey", () => {
	beforeAll(async ({ app, screen }) => {
		await signedIn(app, screen);
	});

	afterAll(async ({ screen }) => {
		await screen.getByTestId(ids.tabs.settings).tap({ until: screen.getByTestId(ids.settings.signOut) });
		await screen.getByTestId(ids.settings.signOut).tap();
		await expect(screen.getByTestId(ids.welcome.screen)).toBeVisible();
	});

	test("adds a todo", async ({ screen }) => {
		await screen.getByTestId(ids.todos.input).fill("Demo describe.serial");
		await screen.getByTestId(ids.todos.add).tap();
		await expect(screen.getByTestId(ids.todos.title("todo-1"))).toHaveText("Demo describe.serial");
		await expect(screen.getByTestId(ids.todos.remaining)).toHaveText("2 left");
	});

	test("completes the todo the previous test added", async ({ screen }) => {
		await screen.getByTestId(ids.todos.check("todo-1")).tap();
		await expect(screen.getByTestId(ids.todos.check("todo-1"))).toBeChecked();
		await expect(screen.getByTestId(ids.todos.remaining)).toHaveText("1 left");
	});

	test("the done filter shows it", async ({ screen }) => {
		await screen.getByTestId(ids.todos.filter("done")).tap();
		await expect(screen.getByTestId(ids.todos.row("todo-1"))).toBeVisible();
		await expect(screen.getByTestId(ids.todos.row("welcome"))).toBeHidden();
	});

	test("settings shows the account signed in by beforeAll", async ({ screen }) => {
		await screen.getByTestId(ids.tabs.settings).tap({ until: screen.getByTestId(ids.settings.email) });
		await expect(screen.getByTestId(ids.settings.email)).toHaveText("ada@example.com");
	});
});
