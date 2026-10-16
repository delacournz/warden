const { expect, element, by } = require("detox");
const { byId, expectTodosAfterSignIn, openSignIn, submitSignIn } = require("./helpers/flows");
const { ids } = require("./helpers/ids");

describe("sign-in", () => {
	it("invalid email and short password show field errors", async () => {
		await openSignIn();
		await submitSignIn("not-an-email", "password1");
		await expect(byId(ids.signIn.emailError)).toHaveText("Enter a valid email address.");
		await submitSignIn("ada@example.com", "short");
		await expect(byId(ids.signIn.passwordError)).toHaveText("Password must be at least 8 characters.");
	});

	it("a locked account shows the form alert", async () => {
		await openSignIn();
		await submitSignIn("locked@example.com", "password1");
		await expect(byId(ids.signIn.formError)).toBeVisible();
		await expect(element(by.text("This account is locked. Try another email."))).toBeVisible();
	});

	it("valid credentials land on todos", async () => {
		await openSignIn();
		await submitSignIn("Ada@Example.com", "password1");
		await expectTodosAfterSignIn();
		await expect(byId(ids.todos.remaining)).toHaveText("1 left");
	});
});
