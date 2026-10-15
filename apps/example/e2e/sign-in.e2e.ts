import { expect, test } from "@delacour/warden-e2e";
import { expectTodosAfterSignIn, openSignIn, submitSignIn } from "./helpers/flows";
import { ids } from "./helpers/ids";

test("invalid email and short password show field errors", async ({ device, screen }) => {
	await openSignIn(device, screen);
	await submitSignIn(screen, "not-an-email", "password1", "tap");
	await expect(screen.getByTestId(ids.signIn.emailError)).toHaveText("Enter a valid email address.");
	await submitSignIn(screen, "ada@example.com", "short", "tap");
	await expect(screen.getByTestId(ids.signIn.passwordError)).toHaveText("Password must be at least 8 characters.");
});

test("a locked account shows the form alert", async ({ device, screen }) => {
	await openSignIn(device, screen);
	await submitSignIn(screen, "locked@example.com", "password1", "tap");
	await expect(screen.getByTestId(ids.signIn.formError)).toBeVisible();
	await expect(screen.getByText("This account is locked. Try another email.")).toBeVisible();
});

test("valid credentials land on todos", async ({ device, screen }) => {
	await openSignIn(device, screen);
	await submitSignIn(screen, "Ada@Example.com", "password1");
	await expectTodosAfterSignIn(device, screen);
	await expect(screen.getByTestId(ids.todos.remaining)).toHaveText("1 left");
});
