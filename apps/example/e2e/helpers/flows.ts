import { expect } from "@delacour/warden-e2e";
import type { Device } from "@delacour/warden-e2e/device";
import type { Screen } from "@delacour/warden-e2e/screen/screen";
import { ids } from "./ids";

/** How long to wait for the todos screen after submitting sign-in, while clearing the Keychain sheet. */
const SIGN_IN_TIMEOUT_MS = 15_000;
const POLL_MS = 250;
/** How long after the todos screen shows to wait for the "Save Password?" sheet (seen 1.3 s later). */
const SAVE_PASSWORD_WAIT_MS = 5_000;

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

/**
 * Answers the iOS "Save Password?" sheet that follows a sign-in. It is a system sheet owned by SpringBoard, it
 * covers the app (testIDs behind it are filtered out of the snapshot while it shows) and it appears about 1.5 s
 * AFTER the todos screen is already visible, so a single check right after sign-in misses it. Polls for
 * `SAVE_PASSWORD_WAIT_MS` and returns once the sheet has been dismissed ("Not Now"), or when it never shows.
 */
export async function dismissSavePassword(device: Device): Promise<boolean> {
	const deadline = Date.now() + SAVE_PASSWORD_WAIT_MS;
	while (Date.now() < deadline) {
		if (await device.alert("dismiss")) {
			await device.settle({ quietMs: 600, timeout: 4000 });
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
	return false;
}

/** Waits for the todos screen after a successful sign-in, then clears the "Save Password?" sheet iOS shows over it. */
export async function expectTodosAfterSignIn(device: Device, screen: Screen): Promise<void> {
	const todos = screen.getByTestId(ids.todos.screen);
	const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
	let visible = false;
	while (!visible && Date.now() < deadline) {
		await device.alert("dismiss");
		visible = await todos.isVisible();
		if (!visible) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
	if (!visible) await expect(todos).toBeVisible({ timeout: 1 });
	await dismissSavePassword(device);
}

const DEEP_LINK_ATTEMPTS = 3;
const DEEP_LINK_WAIT_MS = 6_000;

/**
 * Opens `url` and waits for the screen it targets, opening it again when that screen has not shown. A link
 * opened while the app is still settling after sign-in is occasionally dropped, with nothing on screen to
 * tell it from a slow one, so a single `openLink` followed by an assertion is a coin flip under load.
 */
export async function openDeepLink(device: Device, screen: Screen, url: string, readyTestId: string): Promise<void> {
	const ready = screen.getByTestId(readyTestId);
	for (let attempt = 1; attempt <= DEEP_LINK_ATTEMPTS; attempt++) {
		await device.openLink(url);
		const deadline = Date.now() + DEEP_LINK_WAIT_MS;
		while (Date.now() < deadline) {
			if (await ready.isVisible()) return;
			await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		}
	}
}

/** Fresh launch, signed in as `email`, on the todos tab. */
export async function signedIn(device: Device, screen: Screen, email = "ada@example.com"): Promise<void> {
	await openSignIn(device, screen);
	await submitSignIn(screen, email, "password1");
	await expectTodosAfterSignIn(device, screen);
}
