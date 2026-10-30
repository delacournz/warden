import { expect, type TestFixtures } from "../../index";

const ids = {
	signInOpen: "sign-in-open",
	signInForm: "sign-in-form",
	email: "email",
	password: "password",
	signInSubmit: "sign-in-submit",
} as const;

/** Prerequisite: nothing. */
export async function openApp({ app }: TestFixtures): Promise<void> {
	await app.open({ wait: "quiet" });
}

/** Prerequisite: on welcome */
export async function signIn({ screen }: TestFixtures): Promise<void> {
	const passwordSecret = process.env.WARDEN_UI_SECRET_PASSWORD;
	if (passwordSecret === undefined) throw new Error("set WARDEN_UI_SECRET_PASSWORD to run this spec");
	// Open the sign-in form
	await screen.getByTestId(ids.signInOpen).tap();
	await expect(screen.getByTestId(ids.signInForm)).toBeVisible();
	await screen.getByTestId(ids.email).fill("me@example.com");
	await screen.getByTestId(ids.password).fill(passwordSecret);
	await screen.getByTestId(ids.signInSubmit).tap();
}
