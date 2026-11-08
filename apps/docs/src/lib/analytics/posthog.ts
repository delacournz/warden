import type { PostHog, PostHogConfig } from "posthog-js";
import { ANALYTICS, isCountedHost, type PosthogConfig } from "./config";
import { type Consent, readConsent } from "./consent";
import type { EventData } from "./events";

/**
 * PostHog, in the browser, behind the reverse proxy at `i.delacour.co.nz`.
 *
 * Until the visitor accepts, PostHog runs cookieless: it stores nothing on the
 * device and PostHog's servers count visitors with a privacy-preserving daily
 * hash instead. Accept turns on its cookie and local storage and starts
 * session replay; Decline, or no answer at all, keeps it cookieless. The
 * banner and the stored answer live in `consent.ts`.
 *
 * The SDK is imported only once this build has PostHog on and the page is on
 * a counted host, so a build without the env vars never requests it. The
 * replay recorder is a second, larger chunk, imported only for a visitor who
 * has accepted: external script loading is off, so it has to be bundled.
 */

/**
 * Registered on every browser event. The token is shared with every Delacour
 * site, so one PostHog project holds them all and `site` is what tells
 * warden's events apart; `surface` separates them from the server's.
 */
export const SUPER_PROPERTIES = { site: "warden", surface: "web" } as const;

/** The PostHog app the proxy fronts. Only the toolbar's links use it. */
const UI_HOST = "https://us.posthog.com";

/**
 * The init options. Everything beyond page views, heatmaps, session replay
 * and the site's own events is off, in code rather than in the PostHog
 * project, so that a switch flipped there (surveys, autocapture) cannot reach
 * a visitor unannounced. Remote config stays on, because replay takes its
 * settings from it; the explicit values here win over anything it says.
 *
 * Replay masks every input. Heatmaps are clicks, mouse moves and scroll depth,
 * batched into one `$$heatmap` event, with no element content.
 */
export function posthogOptions(posthog: Extract<PosthogConfig, { kind: "on" }>) {
	return {
		api_host: posthog.host,
		ui_host: UI_HOST,
		defaults: "2026-08-30",
		cookieless_mode: "on_reject",
		opt_out_capturing_by_default: true,
		person_profiles: "identified_only",
		capture_pageview: "history_change",
		capture_heatmaps: true,
		session_recording: { maskAllInputs: true },
		autocapture: false,
		rageclick: false,
		capture_dead_clicks: false,
		capture_exceptions: false,
		capture_performance: false,
		disable_surveys: true,
		disable_external_dependency_loading: true,
	} as const satisfies Partial<PostHogConfig>;
}

/**
 * What PostHog needs telling on load. PostHog stores its own copy of the
 * answer, and the banner's `CONSENT_KEY` is the one that counts, so the two are
 * reconciled whenever they disagree (after storage was partly cleared, say).
 */
export function consentReplay(
	stored: Consent | null,
	current: ReturnType<PostHog["get_explicit_consent_status"]>
): "opt_in" | "opt_out" | null {
	if (stored === "granted" && current !== "granted") return "opt_in";
	if (stored === "denied" && current !== "denied") return "opt_out";
	return null;
}

/**
 * Whether the page is being driven by automation rather than read by a person.
 *
 * WebDriver, Playwright and Puppeteer all set `navigator.webdriver`, and the
 * SDK's own bot list only reads the user agent, which a scraper spoofs. Every
 * headless hit would otherwise be a fresh cookieless "visitor".
 */
export function isAutomatedBrowser(nav: Pick<Navigator, "webdriver"> | undefined): boolean {
	return nav?.webdriver === true;
}

/** The replay recorder registers itself on `window` when imported; the SDK finds it there. */
function loadRecorder(): Promise<unknown> {
	return import("posthog-js/dist/recorder");
}

let client: PostHog | null = null;

/** Load and start PostHog, once, if this build and this host have it, for a person. */
export function startPosthog(posthog: PosthogConfig = ANALYTICS.posthog): void {
	if (posthog.kind === "off" || client || !isCountedHost(window.location.host)) return;
	if (isAutomatedBrowser(window.navigator)) return;

	const stored = readConsent();
	const recorder = stored === "granted" ? loadRecorder() : Promise.resolve();

	void Promise.all([import("posthog-js"), recorder]).then(([{ default: instance }]) => {
		if (client) return;
		instance.init(posthog.token, posthogOptions(posthog));
		instance.register(SUPER_PROPERTIES);
		client = instance;

		const replay = consentReplay(stored, instance.get_explicit_consent_status());
		if (replay === "opt_in") instance.opt_in_capturing();
		if (replay === "opt_out") instance.opt_out_capturing();
	});
}

/** Send one event, if PostHog has loaded. */
export function posthogCapture(name: string, data: EventData): void {
	client?.capture(name, data);
}

/** Tell PostHog the banner's answer: cookies, storage and replay on Accept, cookieless on Decline. */
export function posthogConsent(consent: Consent): void {
	const instance = client;
	if (!instance) return;
	if (consent === "granted") void loadRecorder().then(() => instance.opt_in_capturing());
	else instance.opt_out_capturing();
}
