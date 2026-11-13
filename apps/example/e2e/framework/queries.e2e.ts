import { beforeAll, describe, E2eError, expect, test } from "@delacour/warden-e2e";
import { ids } from "../helpers/ids";
import { SPEC_OPTIONS, signedIn } from "../helpers/steps";

test.use(SPEC_OPTIONS);

/** Runs `action` and returns the `E2eError` it threw; fails when it did not throw one. */
async function errorOf(action: () => Promise<unknown>): Promise<E2eError> {
	try {
		await action();
	} catch (error) {
		if (error instanceof E2eError) return error;
		throw error;
	}
	throw new Error("expected an E2eError, nothing was thrown");
}

/**
 * The query and locator API against the seeded todos screen (`welcome` active, `warden` done), on one launch. Nothing
 * here changes the list, so the tests only read.
 */
describe.serial("framework: queries and locators", () => {
	beforeAll(async ({ app, screen }) => {
		await signedIn(app, screen);
	});

	test("getByTestId finds exactly one node", async ({ screen }) => {
		expect(await screen.getByTestId(ids.todos.add).count()).toBe(1);
		expect(await screen.getByTestId("no-such-test-id").count()).toBe(0);
	});

	test("getByRole narrows by name, checked and disabled", async ({ screen }) => {
		await expect(screen.getByRole("checkbox")).toHaveCount(2);
		await expect(screen.getByRole("checkbox", { name: "Explore the example app" })).toBeChecked({ checked: false });
		await expect(screen.getByRole("checkbox", { checked: true })).toHaveCount(1);
		await expect(screen.getByRole("button", { name: "Add todo", disabled: true })).toHaveCount(1);
	});

	test("getByText matches whole text, a case-insensitive substring and a RegExp", async ({ screen }) => {
		expect(await screen.getByText("1 left").count()).toBeGreaterThan(0);
		expect(await screen.getByText("1 LEF", { exact: false }).count()).toBeGreaterThan(0);
		expect(await screen.getByText(/^\d+ left$/).count()).toBeGreaterThan(0);
		expect(await screen.getByText("1 lef").count()).toBe(0);
	});

	test("getByLabel finds the field by its accessibility label", async ({ screen }) => {
		const field = screen.getByLabel("New todo");
		await expect(field).toHaveCount(1);
		expect((await field.boundingBox()).width).toBeGreaterThan(0);
	});

	test("the selector grammar of locator() matches the query helpers", async ({ screen }) => {
		await expect(screen.locator(`id=${ids.todos.add}`)).toBeDisabled();
		await expect(screen.locator("role=checkbox nth=1")).toBeChecked();
		await expect(screen.locator("role=checkbox nth=0")).toBeChecked({ checked: false });
	});

	test("first, last, nth and filter pick from several matches", async ({ screen }) => {
		const checkboxes = screen.getByRole("checkbox");
		await expect(checkboxes.first()).toBeChecked({ checked: false });
		await expect(checkboxes.last()).toBeChecked();
		await expect(checkboxes.nth(1)).toBeChecked();
		await expect(checkboxes.filter({ hasText: "Run the e2e suite with warden" })).toBeChecked();
		expect(await checkboxes.all()).toHaveLength(2);
	});

	test("reads answer from one look without waiting", async ({ screen }) => {
		const welcome = screen.getByTestId(ids.todos.check("welcome"));
		expect(await welcome.read()).toMatchObject({ visible: true, checked: false });
		expect(await screen.getByTestId("no-such-test-id").read()).toEqual({ visible: false });
		expect(await screen.getByTestId(ids.todos.add).isEnabled()).toBe(false);
		expect(await screen.getByTestId(ids.todos.empty).isHidden()).toBe(true);
		expect(await screen.getByTestId(ids.todos.remaining).text()).toBe("1 left");
	});

	test("boundingBox is in screen points, inside the screen", async ({ screen }) => {
		const input = await screen.getByTestId(ids.todos.input).boundingBox();
		const tab = await screen.getByTestId(ids.tabs.todos).boundingBox();
		expect(input.width).toBeGreaterThan(100);
		expect(tab.y).toBeGreaterThan(input.y);
	});

	test("an action on several matches fails LOCATOR_AMBIGUOUS without touching the app", async ({ screen }) => {
		const error = await errorOf(() => screen.getByRole("checkbox").tap({ timeout: 2_000 }));
		expect(error.code).toBe("LOCATOR_AMBIGUOUS");
		await expect(screen.getByTestId(ids.todos.remaining)).toHaveText("1 left");
	});

	test("waitFor on a node that never shows fails with TIMEOUT", async ({ screen }) => {
		const error = await errorOf(() => screen.getByTestId("no-such-test-id").waitFor({ timeout: 500 }));
		expect(error.code).toBe("TIMEOUT");
	});

	test("a malformed selector fails INVALID_LOCATOR", async ({ screen }) => {
		const error = await errorOf(() => screen.locator("nth=").count());
		expect(error.code).toBe("INVALID_LOCATOR");
	});
});
