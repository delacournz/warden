import { beforeAll, describe, expect, test } from "@delacour/warden-e2e";
import { ids } from "../helpers/ids";
import {
	expectTodosAfterSignIn,
	launch,
	openSettingsTab,
	openSignIn,
	SPEC_OPTIONS,
	signedIn,
	signOut,
	submitSignIn,
} from "../helpers/steps";

test.use(SPEC_OPTIONS);

/**
 * One sign-in form for every validation path, then the happy path: the form keeps its fields between submits, so each
 * test corrects the field the previous one broke, the way a person would.
 */
describe.serial("sign-in form", () => {
	beforeAll(async ({ app, screen }) => {
		await openSignIn(app, screen);
	});

	test("an invalid email shows the email error", async ({ screen }) => {
		await submitSignIn(screen, "not-an-email", "password1");
		await expect(screen.getByTestId(ids.signIn.emailError)).toHaveText("Enter a valid email address.");
		await expect(screen.getByTestId(ids.signIn.screen)).toBeVisible();
	});

	test("a short password shows the password error and clears the email error", async ({ screen }) => {
		await submitSignIn(screen, "ada@example.com", "short");
		await expect(screen.getByTestId(ids.signIn.passwordError)).toHaveText("Password must be at least 8 characters.");
		await expect(screen.getByText("Enter a valid email address.")).toBeHidden();
	});

	test("a locked account shows the form alert", async ({ screen }) => {
		await submitSignIn(screen, "locked@example.com", "password1");
		await expect(screen.getByTestId(ids.signIn.formError)).toBeVisible();
		await expect(screen.getByText("This account is locked. Try another email.")).toBeVisible();
	});

	test("valid credentials land on todos with the seeded list", async ({ screen }) => {
		await submitSignIn(screen, "  Ada@Example.com ", "password1");
		await expectTodosAfterSignIn(screen);
		await expect(screen.getByTestId(ids.todos.remaining)).toHaveText("1 left");
	});

	test("the session keeps the email trimmed and lower-cased", async ({ screen }) => {
		await openSettingsTab(screen);
		await expect(screen.getByTestId(ids.settings.email)).toHaveText("ada@example.com");
	});

	test("signing out returns to the welcome screen", async ({ screen }) => {
		await signOut(screen);
		await expect(screen.getByTestId(ids.welcome.title)).toHaveText("Welcome");
	});
});

/** The session lives in memory: a relaunch is the point of this test, so it is a plain test with two launches. */
test("a relaunch after signing in starts signed out", async ({ app, screen }) => {
	await signedIn(app, screen, "grace@example.com");
	await launch(app, screen);
	await expect(screen.getByTestId(ids.welcome.title)).toHaveText("Welcome");
	await expect(screen.getByTestId(ids.todos.screen)).toBeHidden();
});
