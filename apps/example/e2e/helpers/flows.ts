import { expect } from "@delacour/warden-e2e";
import type { Device } from "@delacour/warden-e2e/device";
import type { Locator } from "@delacour/warden-e2e/screen/locator";
import type { Screen } from "@delacour/warden-e2e/screen/screen";
import { ids } from "./ids";

/** How long to wait for the todos screen after submitting sign-in, while clearing the Keychain sheet. */
const SIGN_IN_TIMEOUT_MS = 15_000;
const POLL_MS = 250;
/** How long a tap gets to show its result before it is sent again, and how often. */
const TAP_RESULT_MS = 4_000;
const TAP_RETRIES = 2;
/** iOS can show "Save Password?" this long after the todos screen is already up. */
const SAVE_PASSWORD_GRACE_MS = 2_500;
/** No sheet for this long: the last one has finished animating away. */
const SHEET_QUIET_MS = 1_000;

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
 * Fresh launch → welcome → the three onboarding steps → sign-in screen. Each step animates in; a tap sent while
 * the previous step is still moving is lost, so the UI settles between taps.
 */
export async function openSignIn(device: Device, screen: Screen): Promise<void> {
	await launch(device, screen);
	await screen.getByTestId(ids.welcome.next).tap();
	await device.settle();
	await screen.getByTestId(ids.welcome.next).tap();
	await device.settle();
	await screen.getByTestId(ids.welcome.getStarted).tap();
	await expect(screen.getByTestId(ids.signIn.screen)).toBeVisible();
}

/**
 * Fill and submit the sign-in form. Submits with Return on the password field by default: tapping the submit button
 * while the keyboard is up loses the next tap on the todos screen, so flows that go on past sign-in use Return.
 * Pass `via: "tap"` to press the button (flows that stay on the form and only read its errors).
 */
export async function submitSignIn(
	screen: Screen,
	email: string,
	password: string,
	via: "enter" | "tap" = "enter"
): Promise<void> {
	await screen.getByTestId(ids.signIn.email).fill(email);
	await screen.getByTestId(ids.signIn.password).fill(password);
	if (via === "tap") await screen.getByTestId(ids.signIn.submit).tap();
	else await screen.getByTestId(ids.signIn.password).press("Enter");
}

/**
 * Waits for the todos screen after a successful sign-in and clears the "Save Password?" sheet. The sheet is a system
 * overlay: the app's accessibility tree cannot see it, it can appear after the todos screen is up, and a tap that
 * lands while it is up or still animating away is lost. So once the screen shows, keep answering the sheet until none
 * has appeared for `SHEET_QUIET_MS`, then let the UI settle.
 */
export async function expectTodosAfterSignIn(device: Device, screen: Screen): Promise<void> {
	const todos = screen.getByTestId(ids.todos.screen);
	const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
	let lastSheetAt = Date.now();
	let shownAt: number | undefined;
	while (Date.now() < deadline) {
		if (await device.alert("dismiss")) lastSheetAt = Date.now();
		if (await todos.isVisible()) {
			shownAt ??= Date.now();
			if (Date.now() - lastSheetAt >= SHEET_QUIET_MS && Date.now() - shownAt >= SAVE_PASSWORD_GRACE_MS) {
				await device.settle();
				return;
			}
		}
		await sleep(POLL_MS);
	}
	await expect(todos).toBeVisible({ timeout: 1 });
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Taps `target` and waits for `arrived`. The first touch after sign-in is sometimes lost while the screen is still
 * finishing its transition (seen on a heavily loaded host), so a tap that brought nothing up is sent once more.
 */
export async function tapUntilVisible(target: Locator, arrived: Locator): Promise<void> {
	await target.tap();
	for (let attempt = 0; attempt < TAP_RETRIES; attempt += 1) {
		if (await waitVisible(arrived, TAP_RESULT_MS)) return;
		await target.tap();
	}
}

async function waitVisible(target: Locator, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await target.isVisible()) return true;
		await sleep(POLL_MS);
	}
	return target.isVisible();
}

/** Fresh launch, signed in as `email`, on the todos tab. */
export async function signedIn(device: Device, screen: Screen, email = "ada@example.com"): Promise<void> {
	await openSignIn(device, screen);
	await submitSignIn(screen, email, "password1");
	await expectTodosAfterSignIn(device, screen);
}
