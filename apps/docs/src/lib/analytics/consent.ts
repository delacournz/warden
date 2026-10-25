import { posthogConsent } from "./posthog";

/**
 * Consent for PostHog's cookie, local storage and session replay. PostHog
 * runs cookieless until the visitor accepts; one banner and one stored answer
 * gate it.
 *
 * The choice lives in `localStorage` under `CONSENT_KEY`. It is read twice: by
 * `startPosthog`, to bring PostHog's own stored answer into line, and by the
 * banner, to decide whether to ask.
 */

export const CONSENT_KEY = "consent.analytics";

export type Consent = "granted" | "denied";

/** The window event the footer's "Cookie settings" link fires to reopen the banner. */
export const CONSENT_OPEN_EVENT = "consent:open";

export function parseConsent(value: string | null): Consent | null {
	return value === "granted" || value === "denied" ? value : null;
}

export function readConsent(): Consent | null {
	try {
		return parseConsent(window.localStorage.getItem(CONSENT_KEY));
	} catch {
		return null;
	}
}

/**
 * Store the choice and tell PostHog. Accepting lets it persist and starts
 * replay; declining after an earlier accept sends it back to cookieless,
 * clearing what it stored.
 */
export function writeConsent(consent: Consent): void {
	try {
		window.localStorage.setItem(CONSENT_KEY, consent);
	} catch {
		// A blocked storage still gets this page's answer; it just asks again next visit.
	}
	posthogConsent(consent);
}
