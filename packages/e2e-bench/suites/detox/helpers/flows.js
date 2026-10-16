const { by, device, element, expect, waitFor } = require("detox");
const { ids } = require("./ids");

const TAP_RESULT_MS = 4000;
const TAP_RETRIES = 2;
const DEEP_LINK_ATTEMPTS = 3;
const DEEP_LINK_WAIT_MS = 6000;
const SIGN_IN_TIMEOUT_MS = 15000;

const byId = (id) => element(by.id(id));

/**
 * True when the matcher `method` (toBeVisible, toHaveText, ...) holds on element `id` within `ms`. Detox's
 * waitFor throws on timeout, which we turn into false so callers can retry.
 */
async function within(ms, id, method, arg) {
	try {
		const waiting = waitFor(byId(id));
		await (arg === undefined ? waiting[method]() : waiting[method](arg)).withTimeout(ms);
		return true;
	} catch {
		return false;
	}
}

/**
 * Fresh app instance on the signed-out welcome screen. Detox dismisses nothing itself, so the system-alert rule of
 * the parity contract is covered by launching with permissions pre-granted and no sheet expected at launch.
 */
async function launch() {
	await device.launchApp({ newInstance: true });
	await waitFor(byId(ids.welcome.screen)).toBeVisible().withTimeout(30000);
}

/**
 * Taps `targetId`, then waits up to 4 s for `arrivedId` to satisfy `method`/`arg`; re-taps up to 2 times.
 * Same retry contract as tapUntil in apps/example/e2e/helpers/flows.ts: the first press after a transition can be dropped.
 */
async function tapUntil(targetId, arrivedId, method, arg) {
	await byId(targetId).tap();
	for (let attempt = 0; attempt < TAP_RETRIES; attempt += 1) {
		if (await within(TAP_RESULT_MS, arrivedId, method, arg)) return;
		await byId(targetId).tap();
	}
}

/** Presses Next on the welcome screen until the step title reads `title`. */
async function nextStep(title) {
	await tapUntil(ids.welcome.next, ids.welcome.title, "toHaveText", title);
	await expect(byId(ids.welcome.title)).toHaveText(title);
}

/** Welcome → Plan → Test → sign-in screen. */
async function openSignIn() {
	await launch();
	await nextStep("Plan");
	await nextStep("Test");
	await byId(ids.welcome.getStarted).tap();
	await expect(byId(ids.signIn.screen)).toBeVisible();
}

/** Fill and submit the sign-in form. */
async function submitSignIn(email, password) {
	await byId(ids.signIn.email).replaceText(email);
	await byId(ids.signIn.password).replaceText(password);
	await byId(ids.signIn.submit).tap();
}

/** Waits up to 15 s for the todos screen after sign-in. */
async function expectTodosAfterSignIn() {
	await waitFor(byId(ids.todos.screen)).toBeVisible().withTimeout(SIGN_IN_TIMEOUT_MS);
}

/** Fresh launch, signed in as `email`, on the todos tab. */
async function signedIn(email = "ada@example.com") {
	await openSignIn();
	await submitSignIn(email, "password1");
	await expectTodosAfterSignIn();
}

/** Opens `url`, waits up to 6 s for `readyId`, reopens up to 3 attempts. */
async function openDeepLink(url, readyId) {
	for (let attempt = 1; attempt <= DEEP_LINK_ATTEMPTS; attempt += 1) {
		await device.openURL({ url });
		if (await within(DEEP_LINK_WAIT_MS, readyId, "toBeVisible")) return;
	}
}

module.exports = {
	byId,
	launch,
	tapUntil,
	nextStep,
	openSignIn,
	submitSignIn,
	expectTodosAfterSignIn,
	signedIn,
	openDeepLink,
};
