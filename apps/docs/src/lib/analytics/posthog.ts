import type { PostHog, PostHogConfig } from "posthog-js";
import { ANALYTICS, isCountedHost, type PosthogConfig } from "./config";
import type { EventData } from "./events";

/**
 * PostHog, in the browser, behind the reverse proxy at `i.delacour.co.nz`.
 *
 * It runs cookieless, always: nothing is stored on the device and PostHog's
 * servers count visitors with a privacy-preserving daily hash instead. That is
 * why the site has no consent banner; there is no cookie to consent to.
 *
 * The SDK is imported only once this build has PostHog on and the page is on
 * a counted host, so a build without the env vars never requests it.
 */

/** The PostHog app the proxy fronts. Only the toolbar's links use it. */
const UI_HOST = "https://us.posthog.com";

/**
 * The init options. Everything beyond page views and the site's own events is
 * off, in code rather than in the PostHog project, so that a switch flipped
 * there (session replay, surveys, heatmaps) cannot reach a visitor unannounced.
 */
export function posthogOptions(posthog: Extract<PosthogConfig, { kind: "on" }>) {
	return {
		api_host: posthog.host,
		ui_host: UI_HOST,
		defaults: "2026-08-30",
		cookieless_mode: "always",
		persistence: "memory",
		person_profiles: "identified_only",
		capture_pageview: "history_change",
		autocapture: false,
		rageclick: false,
		capture_dead_clicks: false,
		capture_heatmaps: false,
		capture_exceptions: false,
		capture_performance: false,
		disable_session_recording: true,
		disable_surveys: true,
		advanced_disable_flags: true,
		disable_external_dependency_loading: true,
	} as const satisfies Partial<PostHogConfig>;
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

let client: PostHog | null = null;

/** Load and start PostHog, once, if this build and this host have it, for a person. */
export function startPosthog(posthog: PosthogConfig = ANALYTICS.posthog): void {
	if (posthog.kind === "off" || client || !isCountedHost(window.location.host)) return;
	if (isAutomatedBrowser(window.navigator)) return;

	void import("posthog-js").then(({ default: instance }) => {
		if (client) return;
		instance.init(posthog.token, posthogOptions(posthog));
		client = instance;
	});
}

/** Send one event, if PostHog has loaded. */
export function posthogCapture(name: string, data: EventData): void {
	client?.capture(name, data);
}
