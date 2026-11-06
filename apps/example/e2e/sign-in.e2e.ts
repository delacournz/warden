import { expect, test } from "@delacour/warden-e2e";
import { ids } from "./helpers/ids";
import { expectTodosAfterSignIn, openSignIn, SPEC_OPTIONS, submitSignIn } from "./helpers/steps";

test.use(SPEC_OPTIONS);

test("invalid email and short password show field errors", async ({ app, screen }) => {
	await openSignIn(app, screen);
	await submitSignIn(screen, "not-an-email", "password1");
	await expect(screen.getByTestId(ids.signIn.emailError)).toHaveText("Enter a valid email address.");
	await submitSignIn(screen, "ada@example.com", "short");
	await expect(screen.getByTestId(ids.signIn.passwordError)).toHaveText("Password must be at least 8 characters.");
});

test("a locked account shows the form alert", async ({ app, screen }) => {
	await openSignIn(app, screen);
	await submitSignIn(screen, "locked@example.com", "password1");
	await expect(screen.getByTestId(ids.signIn.formError)).toBeVisible();
	await expect(screen.getByText("This account is locked. Try another email.")).toBeVisible();
});

test("valid credentials land on todos", async ({ app, screen }) => {
	await openSignIn(app, screen);
	await submitSignIn(screen, "Ada@Example.com", "password1");
	await expectTodosAfterSignIn(screen);
	await expect(screen.getByTestId(ids.todos.remaining)).toHaveText("1 left");
});
