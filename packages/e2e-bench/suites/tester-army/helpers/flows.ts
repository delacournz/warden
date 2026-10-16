import type { Device } from "@e2e-dev/mobile";
import { type App, expect, type Locator, type Screen } from "e2e";
import { ids } from "./ids";

/** How long to wait for the todos screen after submitting sign-in, while clearing system sheets. */
const SIGN_IN_TIMEOUT_MS = 15_000;
const POLL_MS = 250;
/** How long a tap gets to show its result before it is sent again, and how many times. */
const TAP_RESULT_MS = 4_000;
const TAP_RETRIES = 2;
const DEEP_LINK_ATTEMPTS = 3;
const DEEP_LINK_WAIT_MS = 6_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Clears iOS prompts that cover the app and are not part of it: the "Open in “warden-example”?" sheet a
 * deep link leaves behind and Keychain's "Save Password?" sheet. Each check is immediate, so a clean
 * screen costs nothing.
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

export type TapUntilOptions = {
	/** how long each press gets to show its result. Default 4 s. */
	windowMs?: number;
	/** how often `arrived` is checked. Default 250 ms. */
	pollMs?: number;
};

/**
 * Taps `target` and waits for `arrived`, tapping again (at most twice) when nothing came up. Parity with
 * the warden suite: the first press on the welcome Next button, the tab bar or a list row after sign-in
 * can be dropped, so every framework in the bench retries it the same way.
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
			if (await arrived().catch(() => false)) return;
			await sleep(pollMs);
		}
		await target.tap();
	}
}

/** `tapUntil` for a target whose result is `arrived` being visible. */
export async function tapUntilVisible(target: Locator, arrived: Locator): Promise<void> {
	await tapUntil(target, () => arrived.isVisible());
}

/** Presses Next on the welcome screen until the step title reads `title`. */
export async function nextStep(screen: Screen, title: "Plan" | "Test"): Promise<void> {
	const heading = screen.getByTestId(ids.welcome.title);
	await tapUntil(
		screen.getByTestId(ids.welcome.next),
		async () => (await heading.isVisible()) && (await heading.textContent())?.trim() === title
	);
	await expect(heading).toHaveText(title);
}

/** Fresh launch → welcome → the three onboarding steps → sign-in screen. */
export async function openSignIn(app: App, device: Device, screen: Screen): Promise<void> {
	await launch(app, device, screen);
	await nextStep(screen, "Plan");
	await nextStep(screen, "Test");
	await screen.getByTestId(ids.welcome.getStarted).tap();
	await expect(screen.getByTestId(ids.signIn.screen)).toBeVisible();
}

/**
 * `fill`, tolerant of the engine failing to confirm text it did type (seen on a loaded machine): the
 * field is then checked itself. A secure field hides its value, so it is filled again instead.
 */
export async function fillField(field: Locator, text: string, secure = false): Promise<void> {
	try {
		await field.fill(text);
	} catch {
		if (secure) await field.fill(text);
		else await expect(field).toHaveValue(text);
	}
}

/** Fill and submit the sign-in form. */
export async function submitSignIn(screen: Screen, email: string, password: string): Promise<void> {
	await fillField(screen.getByTestId(ids.signIn.email), email);
	await fillField(screen.getByTestId(ids.signIn.password), password, true);
	await screen.getByTestId(ids.signIn.submit).tap();
}

/** Waits up to 15 s for the todos screen after a successful sign-in, dismissing system sheets meanwhile. */
export async function expectTodosAfterSignIn(device: Device, screen: Screen): Promise<void> {
	const todos = screen.getByTestId(ids.todos.screen);
	const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await clearSystemPrompts(device, screen);
		if (await todos.isVisible().catch(() => false)) return;
		await sleep(POLL_MS);
	}
	await expect(todos).toBeVisible({ timeout: 1 });
}

/**
 * Opens `url` and waits up to 6 s for the screen it targets, opening it again (3 attempts) when that
 * screen has not shown. Answers iOS's "Open in …?" prompt after each open, when it appears.
 */
export async function openDeepLink(device: Device, screen: Screen, url: string, readyTestId: string): Promise<void> {
	const ready = screen.getByTestId(readyTestId);
	for (let attempt = 1; attempt <= DEEP_LINK_ATTEMPTS; attempt += 1) {
		await device.openLink(url);
		await device.alert("accept").catch(() => undefined);
		const deadline = Date.now() + DEEP_LINK_WAIT_MS;
		while (Date.now() < deadline) {
			if (await ready.isVisible().catch(() => false)) return;
			await sleep(POLL_MS);
		}
	}
}

/**
 * A `Badge` / `Chip` showing `text`. The text node inside is matched, not the container: iOS only
 * sometimes copies the text up to the container as its label.
 */
export async function expectLabel(container: Locator, text: string): Promise<void> {
	await expect(container.getByText(text).first()).toBeVisible();
}

/** The navbar badge reads `<count> left`. */
export async function expectRemaining(screen: Screen, count: number): Promise<void> {
	await expectLabel(screen.getByTestId(ids.todos.remaining), `${count} left`);
}

/** Fresh launch, signed in as `email`, on the todos tab. */
export async function signedIn(app: App, device: Device, screen: Screen, email = "ada@example.com"): Promise<void> {
	await openSignIn(app, device, screen);
	await submitSignIn(screen, email, "password1");
	await expectTodosAfterSignIn(device, screen);
}
