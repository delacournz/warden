import { beforeAll, describe, E2eError, expect, test } from "@delacour/warden-e2e";
import { ids } from "../helpers/ids";
import { SPEC_OPTIONS, signedIn } from "../helpers/steps";

test.use(SPEC_OPTIONS);

/**
 * Every locator matcher on the todos screen, on one launch: positive, `.not`, options and a failure's error code.
 * The one change (a todo added) is made by the test whose title says so.
 */
describe.serial("framework: matchers", () => {
	beforeAll(async ({ app, screen }) => {
		await signedIn(app, screen);
	});

	test("toBeVisible / toBeHidden and their .not", async ({ screen }) => {
		await expect(screen.getByTestId(ids.todos.input)).toBeVisible();
		await expect(screen.getByTestId(ids.todos.empty)).toBeHidden();
		await expect(screen.getByTestId(ids.todos.empty)).not.toBeVisible();
		await expect(screen.getByTestId(ids.todos.input)).not.toBeHidden();
	});

	test("toHaveText takes a string, a RegExp and exact: false", async ({ screen }) => {
		const remaining = screen.getByTestId(ids.todos.remaining);
		await expect(remaining).toHaveText("1 left");
		await expect(remaining).toHaveText(/^\d left$/);
		await expect(remaining).toHaveText("1 LEFT", { exact: false });
		await expect(remaining).not.toHaveText("2 left");
	});

	test("toContainText matches part of the text, ignoreCase when asked", async ({ screen }) => {
		const title = screen.getByTestId(ids.todos.title("warden"));
		await expect(title).toContainText("e2e suite");
		await expect(title).toContainText("E2E SUITE", { ignoreCase: true });
		await expect(title).not.toContainText("cypress");
	});

	test("toBeEnabled / toBeDisabled follow the draft", async ({ screen }) => {
		const add = screen.getByTestId(ids.todos.add);
		await expect(add).toBeDisabled();
		await screen.getByTestId(ids.todos.input).fill("Matchers");
		await expect(add).toBeEnabled();
		await expect(add).not.toBeDisabled();
	});

	test("toHaveValue reads the field", async ({ screen }) => {
		await expect(screen.getByTestId(ids.todos.input)).toHaveValue("Matchers");
	});

	test("toBeChecked and checked: false read a checkbox", async ({ screen }) => {
		await expect(screen.getByTestId(ids.todos.check("warden"))).toBeChecked();
		await expect(screen.getByTestId(ids.todos.check("welcome"))).toBeChecked({ checked: false });
		await expect(screen.getByTestId(ids.todos.check("welcome"))).not.toBeChecked();
	});

	test("toHaveCount polls until the count matches, after adding a todo", async ({ screen }) => {
		await screen.getByTestId(ids.todos.add).tap();
		await expect(screen.getByRole("checkbox")).toHaveCount(3);
		await expect(screen.getByTestId(ids.todos.row("no-such-row"))).toHaveCount(0);
	});

	test("expect.soft that passes leaves the test passing", async ({ screen }) => {
		await expect.soft(screen.getByTestId(ids.todos.remaining)).toHaveText("2 left");
	});

	test("a matcher that never holds fails ASSERTION within its timeout", async ({ screen }) => {
		const started = Date.now();
		let caught: unknown;
		try {
			await expect(screen.getByTestId(ids.todos.remaining)).toHaveText("99 left", { timeout: 500 });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(E2eError);
		expect((caught as E2eError).code).toBe("ASSERTION");
		expect(Date.now() - started).toBeLessThan(4_000);
	});

	test("plain values go to bun's expect", () => {
		expect([1, 2, 3]).toContain(2);
		expect({ a: 1 }).toEqual({ a: 1 });
	});
});
