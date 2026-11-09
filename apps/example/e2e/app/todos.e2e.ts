import { beforeAll, describe, expect, test } from "@delacour/warden-e2e";
import { ids } from "../helpers/ids";
import { openDeepLink, SPEC_OPTIONS, signedIn } from "../helpers/steps";

test.use(SPEC_OPTIONS);

/**
 * The todo list from the seeded state to an emptied one, on one launch and one sign-in. The seed is `welcome`
 * (active) and `warden` (done); the first todo added is `todo-1`. Every test leaves the list in the state the next
 * one names in its title.
 */
describe.serial("todos journey", () => {
	beforeAll(async ({ app, screen }) => {
		await signedIn(app, screen);
	});

	test("the seeded list has one active and one done todo", async ({ screen }) => {
		await expect(screen.getByTestId(ids.todos.title("welcome"))).toHaveText("Explore the example app");
		await expect(screen.getByTestId(ids.todos.check("welcome"))).toBeChecked({ checked: false });
		await expect(screen.getByTestId(ids.todos.title("warden"))).toHaveText("Run the e2e suite with warden");
		await expect(screen.getByTestId(ids.todos.check("warden"))).toBeChecked();
		await expect(screen.getByTestId(ids.todos.remaining)).toHaveText("1 left");
	});

	test("Add stays disabled until the draft has text", async ({ screen }) => {
		await expect(screen.getByTestId(ids.todos.add)).toBeDisabled();
		await screen.getByTestId(ids.todos.input).fill("   ");
		await expect(screen.getByTestId(ids.todos.add)).toBeDisabled();
		await screen.getByTestId(ids.todos.input).fill("Write e2e specs");
		await expect(screen.getByTestId(ids.todos.add)).toBeEnabled();
	});

	test("adding appends the todo as active", async ({ screen }) => {
		await screen.getByTestId(ids.todos.add).tap();
		await expect(screen.getByTestId(ids.todos.title("todo-1"))).toHaveText("Write e2e specs");
		await expect(screen.getByTestId(ids.todos.check("todo-1"))).toBeChecked({ checked: false });
		await expect(screen.getByTestId(ids.todos.remaining)).toHaveText("2 left");
		await expect(screen.getByTestId(ids.todos.add)).toBeDisabled();
	});

	test("checking a todo counts it done", async ({ screen }) => {
		await screen.getByTestId(ids.todos.check("todo-1")).tap();
		await expect(screen.getByTestId(ids.todos.check("todo-1"))).toBeChecked();
		await expect(screen.getByTestId(ids.todos.remaining)).toHaveText("1 left");
	});

	test("the Active filter hides done todos", async ({ screen }) => {
		await screen.getByTestId(ids.todos.filter("active")).tap();
		await expect(screen.getByTestId(ids.todos.row("welcome"))).toBeVisible();
		await expect(screen.getByTestId(ids.todos.row("todo-1"))).toBeHidden();
		await expect(screen.getByTestId(ids.todos.row("warden"))).toBeHidden();
	});

	test("completing the last active todo leaves the Active filter empty", async ({ screen }) => {
		await screen.getByTestId(ids.todos.check("welcome")).tap();
		await expect(screen.getByTestId(ids.todos.empty)).toBeVisible();
		await expect(screen.getByTestId(ids.todos.remaining)).toHaveText("0 left");
	});

	test("the Done filter shows only done todos", async ({ screen }) => {
		await screen.getByTestId(ids.todos.filter("done")).tap();
		await expect(screen.getByTestId(ids.todos.row("welcome"))).toBeVisible();
		await expect(screen.getByTestId(ids.todos.row("warden"))).toBeVisible();
		await expect(screen.getByTestId(ids.todos.row("todo-1"))).toBeVisible();
		await expect(screen.getByTestId(ids.todos.empty)).toBeHidden();
	});

	test("the All filter shows every todo", async ({ screen }) => {
		await screen.getByTestId(ids.todos.filter("all")).tap();
		for (const id of ["welcome", "warden", "todo-1"]) {
			await expect(screen.getByTestId(ids.todos.row(id))).toBeVisible();
		}
	});

	test("tapping a todo opens its detail", async ({ screen }) => {
		await screen.getByTestId(ids.todos.title("welcome")).tap({ until: screen.getByTestId(ids.detail.title) });
		await expect(screen.getByTestId(ids.detail.title)).toHaveText("Explore the example app");
		await expect(screen.getByTestId(ids.detail.status)).toHaveText("Done");
	});

	test("toggling in the detail flips its status", async ({ screen }) => {
		await screen.getByTestId(ids.detail.toggle).tap();
		await expect(screen.getByTestId(ids.detail.status)).toHaveText("Active");
	});

	test("Back shows the list with the change", async ({ screen }) => {
		await screen.getByTestId(ids.detail.back).tap({ until: screen.getByTestId(ids.todos.screen) });
		await expect(screen.getByTestId(ids.todos.check("welcome"))).toBeChecked({ checked: false });
		await expect(screen.getByTestId(ids.todos.remaining)).toHaveText("1 left");
	});

	test("deleting from the detail removes the row", async ({ screen }) => {
		await screen.getByTestId(ids.todos.title("welcome")).tap({ until: screen.getByTestId(ids.detail.title) });
		await screen.getByTestId(ids.detail.remove).tap();
		await expect(screen.getByTestId(ids.todos.screen)).toBeVisible();
		await expect(screen.getByTestId(ids.todos.row("welcome"))).toHaveCount(0);
		await expect(screen.getByTestId(ids.todos.remaining)).toHaveText("0 left");
	});

	test("a deep link opens a todo by id", async ({ device, screen }) => {
		await openDeepLink(device, screen, "warden-example://todo/warden", ids.detail.title);
		await expect(screen.getByTestId(ids.detail.title)).toHaveText("Run the e2e suite with warden");
		await expect(screen.getByTestId(ids.detail.status)).toHaveText("Done");
	});

	test("a deep link to a deleted todo shows the missing state", async ({ device, screen }) => {
		await openDeepLink(device, screen, "warden-example://todo/welcome", ids.detail.missing);
		await expect(screen.getByTestId(ids.detail.missing)).toBeVisible();
		await expect(screen.getByTestId(ids.detail.toggle)).toBeHidden();
	});
});
