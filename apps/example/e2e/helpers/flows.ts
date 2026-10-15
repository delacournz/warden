import { expect } from "@delacour/warden-e2e";
import type { Device } from "@delacour/warden-e2e/device";
import type { Screen } from "@delacour/warden-e2e/screen/screen";
import { ids } from "./ids";

/** How long to wait for the todos screen after submitting sign-in, while clearing the Keychain sheet. */
const SIGN_IN_TIMEOUT_MS = 15_000;
const POLL_MS = 250;

/**
 * The runner opens the app fresh before every test (`launch: "fresh"`), so a flow starts on the
 * welcome screen. A leftover system prompt that covers the app (the "Open in “warden-example”?"
 * sheet from a deep link survives a reinstall) is dismissed first.
 */
export async function launch(device: Device, screen: Screen): Promise<void> {
	await device.alert("dismiss");
	await expect(screen.getByTestId(ids.welcome.screen)).toBeVisible({ timeout: 30_000 });
}

/**
 * Fresh launch → welcome → the three onboarding steps → sign-in screen. Each step's title is awaited before the
 * next tap: a second tap that lands while the step is still transitioning is dropped.
 */
export async function openSignIn(device: Device, screen: Screen): Promise<void> {
	await launch(device, screen);
	await screen.getByTestId(ids.welcome.next).tap();
	await expect(screen.getByTestId(ids.welcome.title)).toHaveText("Plan");
	await screen.getByTestId(ids.welcome.next).tap();
	await expect(screen.getByTestId(ids.welcome.title)).toHaveText("Test");
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
		await device.alert("dismiss");
		if (await todos.isVisible()) return;
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
	await expect(todos).toBeVisible({ timeout: 1 });
}

/** Fresh launch, signed in as `email`, on the todos tab. */
export async function signedIn(device: Device, screen: Screen, email = "ada@example.com"): Promise<void> {
	await openSignIn(device, screen);
	await submitSignIn(screen, email, "password1");
	await expectTodosAfterSignIn(device, screen);
}
