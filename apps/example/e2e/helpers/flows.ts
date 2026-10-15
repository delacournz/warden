import { expect } from "@delacour/warden-e2e";
import type { Device } from "@delacour/warden-e2e/device";
import type { Screen } from "@delacour/warden-e2e/screen/screen";
import { ids } from "./ids";

/** How long to wait for the todos screen after submitting sign-in, while clearing the Keychain sheet. */
const SIGN_IN_TIMEOUT_MS = 15_000;
const POLL_MS = 250;
/** iOS shows "Save Password?" up to this long after the todos screen is already up. */
const SAVE_PASSWORD_GRACE_MS = 3_000;
/** Touches that land while the dismissed sheet is still animating away are lost. */
const SHEET_DISMISS_MS = 1_000;

/**
 * The runner opens the app fresh before every test (`launch: "fresh"`), so a flow starts on the
 * welcome screen. A leftover system prompt that covers the app (the "Open in “warden-example”?"
 * sheet from a deep link survives a reinstall) is dismissed first.
 */
export async function launch(device: Device, screen: Screen): Promise<void> {
	await device.alert("dismiss");
	await expect(screen.getByTestId(ids.welcome.screen)).toBeVisible({ timeout: 30_000 });
}

/** Fresh launch → welcome → the three onboarding steps → sign-in screen. */
export async function openSignIn(device: Device, screen: Screen): Promise<void> {
	await launch(device, screen);
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

/**
 * Waits for the todos screen after a successful sign-in and clears the "Save Password?" sheet. The sheet is a system
 * overlay the app's accessibility tree cannot see, it can appear after the todos screen, and while it is up the first
 * tap only dismisses it: so after the screen shows, keep answering it for a grace period.
 */
export async function expectTodosAfterSignIn(device: Device, screen: Screen): Promise<void> {
	const todos = screen.getByTestId(ids.todos.screen);
	const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await device.alert("dismiss");
		if (await todos.isVisible()) {
			await dismissSavePassword(device);
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
	await expect(todos).toBeVisible({ timeout: 1 });
}

/** Presses "Not Now" when iOS offers to save the password, waiting up to the grace period for it to show. */
async function dismissSavePassword(device: Device): Promise<void> {
	const deadline = Date.now() + SAVE_PASSWORD_GRACE_MS;
	while (Date.now() < deadline) {
		if (await device.alert("dismiss")) {
			await new Promise((resolve) => setTimeout(resolve, SHEET_DISMISS_MS));
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
}

/** Fresh launch, signed in as `email`, on the todos tab. */
export async function signedIn(device: Device, screen: Screen, email = "ada@example.com"): Promise<void> {
	await openSignIn(device, screen);
	await submitSignIn(screen, email, "password1");
	await expectTodosAfterSignIn(device, screen);
}
