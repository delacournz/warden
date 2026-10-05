import type { Device } from "@e2e-dev/mobile";
import { type App, expect, type Screen } from "e2e";
import { ids } from "./ids";

/** How long to wait for the todos screen after submitting sign-in, while clearing the Keychain sheet. */
const SIGN_IN_TIMEOUT_MS = 15_000;
const POLL_MS = 250;

/**
 * Clears iOS prompts that cover the app and are not part of it:
 * - "Open in “warden-example”?" left by a deep link (`simctl openurl`); it survives a reinstall;
 * - Keychain's "Save Password?" sheet after a password field submits.
 * Each check is immediate, so a clean screen costs nothing.
 */
export async function clearSystemPrompts(device: Device, screen: Screen): Promise<void> {
	await device.alert("dismiss").catch(() => undefined);
	const notNow = screen.getByRole("button", "Not Now");
	if (await notNow.isVisible().catch(() => false)) await notNow.tap();
}

/** Fresh launch on the welcome screen, with any leftover system prompt cleared. */
export async function launch(app: App, device: Device, screen: Screen): Promise<void> {
	await app.open();
	await clearSystemPrompts(device, screen);
	await expect(screen.getByTestId(ids.welcome.screen)).toBeVisible({ timeout: 30_000 });
}

/** Fresh launch → welcome → the three onboarding steps → sign-in screen. */
export async function openSignIn(app: App, device: Device, screen: Screen): Promise<void> {
	await launch(app, device, screen);
	await screen.getByTestId(ids.welcome.next).tap();
	await screen.getByTestId(ids.welcome.next).tap();
	await screen.getByTestId(ids.welcome.getStarted).tap();
	await expect(screen.getByTestId(ids.signIn.screen)).toBeVisible();
}

/** Fill and submit the sign-in form. */
export async function submitSignIn(screen: Screen, email: string, password: string): Promise<void> {
	await screen.getByTestId(ids.signIn.email).fill(email);
	await screen.getByTestId(ids.signIn.password).fill(password);
	await screen.getByTestId(ids.signIn.submit).tap();
}

/** Waits for the todos screen after a successful sign-in, dismissing the "Save Password?" sheet if iOS shows it. */
export async function expectTodosAfterSignIn(device: Device, screen: Screen): Promise<void> {
	const todos = screen.getByTestId(ids.todos.screen);
	const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await clearSystemPrompts(device, screen);
		if (await todos.isVisible().catch(() => false)) return;
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
	await expect(todos).toBeVisible({ timeout: 1 });
}

/** Fresh launch, signed in as `email`, on the todos tab. */
export async function signedIn(app: App, device: Device, screen: Screen, email = "ada@example.com"): Promise<void> {
	await openSignIn(app, device, screen);
	await submitSignIn(screen, email, "password1");
	await expectTodosAfterSignIn(device, screen);
}
