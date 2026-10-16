import { type App, type Device, expect, type Screen, type TapOptions } from "@delacour/warden-e2e";
import { ids } from "./ids";

/** How long to wait for the todos screen after submitting sign-in. */
const SIGN_IN_TIMEOUT_MS = 15_000;

/**
 * What every flow file passes to `test.use`. `launch: "none"` leaves the opening to the flow (`launch()` below, which
 * waits for the app to be in front and still, so the runner's own bare `app.open()` would be a second launch).
 * `systemAlerts: "dismiss"` answers a system sheet that covers the app (the "Open in “warden-example”?" sheet from a
 * deep link survives a reinstall) wherever a read, tap or assertion meets one, so no flow polls for sheets itself.
 */
export const FLOW_OPTIONS = { launch: "none", systemAlerts: "dismiss" } as const;

/**
 * Opens the app fresh and waits for the welcome screen. `wait: "quiet"` returns once the app is in front and its screen
 * has stopped moving; the welcome screen can still be sliding in then, which is why the Next presses below re-send.
 */
export async function launch(app: Pick<App, "open">, screen: Screen): Promise<void> {
	await app.open({ wait: "quiet" });
	await expect(screen.getByTestId(ids.welcome.screen)).toBeVisible({ timeout: 30_000 });
}

/**
 * Fresh launch → welcome → the three onboarding steps → sign-in screen. Each step's title is awaited before the
 * next tap: a second tap that lands while the step is still transitioning is dropped.
 */
export async function openSignIn(app: Pick<App, "open">, screen: Screen): Promise<void> {
	await launch(app, screen);
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
 * that still covers the app (a leftover sheet) is dismissed by `systemAlerts` while waiting.
 *
 * Why it matters: that sheet is hosted by SafariViewService, cold-launched, and showed up between 1 and 6 s after
 * the todos screen. A flow that typed meanwhile sent its keys to no focused field, and the dev client reloaded its
 * JS about 0.5 s into the typing (back to the welcome screen); the reload trigger is inferred from that timing.
 */
export async function expectTodosAfterSignIn(screen: Screen): Promise<void> {
	await expect(screen.getByTestId(ids.todos.screen)).toBeVisible({ timeout: SIGN_IN_TIMEOUT_MS });
}

/**
 * Presses Next on the welcome screen and waits for the step title to become `title`, re-sending the press when
 * it did not change (`tap({ until })`: 4 s a press, two re-sends, unless `options` says otherwise). The button is in
 * the accessibility tree before it takes touches: the app replaces into `/welcome` with a native-stack animation, and
 * the Button is an RNGH GestureDetector whose native handler attaches after mount. `app.open()` returns before the
 * app is on screen and a HID tap has no app-side ack, so a dropped first press looks exactly like a slow one; the
 * title is the only signal. `getByText("Plan")` would be ambiguous with the Steps labels, hence the read of the
 * title's own text.
 */
export async function nextStep(
	screen: Screen,
	title: "Plan" | "Test",
	options: Pick<TapOptions, "windowMs" | "pollMs"> = {}
): Promise<void> {
	const heading = screen.getByTestId(ids.welcome.title);
	await screen.getByTestId(ids.welcome.next).tap({
		...options,
		until: async () => {
			const { visible, text } = await heading.read();
			return visible && text === title;
		},
	});
	await expect(heading).toHaveText(title);
}

const DEEP_LINK_ATTEMPTS = 3;
const DEEP_LINK_WAIT_MS = 6_000;

/**
 * Opens `url` and waits for the screen it targets, opening it again when that screen has not shown. A link
 * opened while the app is still settling after sign-in is occasionally dropped, with nothing on screen to
 * tell it from a slow one, so a single `openLink` followed by an assertion is a coin flip under load.
 */
export async function openDeepLink(
	device: Pick<Device, "openLink">,
	screen: Screen,
	url: string,
	readyTestId: string
): Promise<void> {
	const ready = screen.getByTestId(readyTestId);
	for (let attempt = 1; attempt <= DEEP_LINK_ATTEMPTS; attempt++) {
		await device.openLink(url, { until: ready, waitMs: DEEP_LINK_WAIT_MS });
		if (await ready.isVisible()) return;
	}
}

/** Fresh launch, signed in as `email`, on the todos tab. */
export async function signedIn(app: Pick<App, "open">, screen: Screen, email = "ada@example.com"): Promise<void> {
	await openSignIn(app, screen);
	await submitSignIn(screen, email, "password1");
	await expectTodosAfterSignIn(screen);
}
