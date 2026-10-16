import { expect } from "@delacour/warden-e2e";
import type { Device } from "@delacour/warden-e2e/device";
import type { Locator } from "@delacour/warden-e2e/screen/locator";
import type { Screen } from "@delacour/warden-e2e/screen/screen";
import { ids } from "./ids";

/** How long to wait for the todos screen after submitting sign-in, while clearing any system sheet. */
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
	await device.settle({ quietMs: 250, timeout: 3_000 });
}

/**
 * Fresh launch → welcome → the three onboarding steps → sign-in screen. Each step's title is awaited before the
 * next tap: a second tap that lands while the step is still transitioning is dropped.
 */
export async function openSignIn(device: Device, screen: Screen): Promise<void> {
	await launch(device, screen);
	await nextStep(screen, "Plan");
	await nextStep(screen, "Test");
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
 * Waits for the todos screen after a successful sign-in. The sign-in fields opt out of AutoFill in e2e builds
 * (`NO_AUTOFILL` in `src/app/sign-in.tsx`), so iOS no longer raises the "Save Password?" sheet; a system alert
 * that still covers the app (a leftover sheet) is dismissed while waiting.
 *
 * Why it matters: that sheet is hosted by SafariViewService, cold-launched, and showed up between 1 and 6 s after
 * the todos screen. A flow that typed meanwhile sent its keys to no focused field, and the dev client reloaded its
 * JS about 0.5 s into the typing (back to the welcome screen); the reload trigger is inferred from that timing.
 */
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
}

/** How long a tap gets to show its result before it is sent again, and how many times. */
const TAP_RESULT_MS = 4_000;
const TAP_RETRIES = 2;

export type TapUntilOptions = {
	/** how long each press gets to show its result. Default 4 s. */
	windowMs?: number;
	/** how often `arrived` is checked. Default 250 ms. */
	pollMs?: number;
};

/**
 * Taps `target` and waits for `arrived`, tapping again when nothing came up. The first press on the tab bar or a
 * list row after the sign-in navigation is dropped (reproduced with a bare tap 1-30 s later, with no sheet on
 * screen, on a quiet machine; a second tap always lands), so a flow's first press after `signedIn` goes through here.
 */
export async function tapUntil(
	target: Locator,
	arrived: () => Promise<boolean>,
	options: TapUntilOptions = {}
): Promise<void> {
	const windowMs = options.windowMs ?? TAP_RESULT_MS;
	const pollMs = options.pollMs ?? POLL_MS;
	await target.tap();
	for (let attempt = 0; attempt < TAP_RETRIES; attempt += 1) {
		const deadline = Date.now() + windowMs;
		while (Date.now() < deadline) {
			if (await arrived()) return;
			await new Promise((resolve) => setTimeout(resolve, pollMs));
		}
		await target.tap();
	}
}

/** `tapUntil` for a target that shows up as `arrived` being visible. */
export async function tapUntilVisible(target: Locator, arrived: Locator): Promise<void> {
	await tapUntil(target, () => arrived.isVisible());
}

/**
 * Presses Next on the welcome screen and waits for the step title to become `title`, re-sending the press when
 * it did not change. The button is in the accessibility tree before it takes touches: the app replaces into
 * `/welcome` with a native-stack animation, and the Button is an RNGH GestureDetector whose native handler attaches
 * after mount. `app.open()` returns when `simctl launch` exits and a HID tap has no app-side ack, so a dropped
 * first press looks exactly like a slow one; the title is the only signal. `getByText("Plan")` would be ambiguous
 * with the Steps labels, and `text()` throws when nothing matches, hence the `isVisible` guard.
 */
export async function nextStep(screen: Screen, title: "Plan" | "Test", options: TapUntilOptions = {}): Promise<void> {
	const heading = screen.getByTestId(ids.welcome.title);
	await tapUntil(
		screen.getByTestId(ids.welcome.next),
		async () => (await heading.isVisible()) && (await heading.text()) === title,
		options
	);
	await expect(heading).toHaveText(title);
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
