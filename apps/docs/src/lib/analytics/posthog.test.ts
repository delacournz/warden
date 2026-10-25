import { describe, expect, test } from "bun:test";
import { isAutomatedBrowser, posthogOptions } from "./posthog";

const posthog = { kind: "on", token: "phc_test", host: "https://i.delacour.co.nz" } as const;

describe("posthogOptions", () => {
	const options = posthogOptions(posthog);

	test("sends through the reverse proxy and links to the US app", () => {
		expect(options.api_host).toBe("https://i.delacour.co.nz");
		expect(options.ui_host).toBe("https://us.posthog.com");
	});

	/**
	 * There is no consent banner, so there is nothing a visitor could accept:
	 * PostHog stores nothing on the device, ever, and counts visitors with its
	 * daily-salted server hash instead.
	 */
	test("never sets a cookie or writes to storage", () => {
		expect(options.cookieless_mode).toBe("always");
		expect(options.persistence).toBe("memory");
	});

	test("captures only page views, page leaves and the site's own events", () => {
		expect(options.autocapture).toBe(false);
		expect(options.capture_pageview).toBe("history_change");
		expect(options.rageclick).toBe(false);
		expect(options.capture_dead_clicks).toBe(false);
		expect(options.capture_heatmaps).toBe(false);
		expect(options.capture_exceptions).toBe(false);
		expect(options.capture_performance).toBe(false);
	});

	/**
	 * A switch flipped in the PostHog project (session replay, surveys,
	 * heatmaps) must not reach a visitor without a change here, so remote
	 * config is off and nothing is loaded beyond the SDK itself.
	 */
	test("records no sessions and takes no configuration from the PostHog project", () => {
		expect(options.disable_session_recording).toBe(true);
		expect(options.disable_surveys).toBe(true);
		expect(options.advanced_disable_flags).toBe(true);
		expect(options.disable_external_dependency_loading).toBe(true);
		expect(options.person_profiles).toBe("identified_only");
	});
});

describe("isAutomatedBrowser", () => {
	test("is true when WebDriver, Playwright or Puppeteer drive the page", () => {
		expect(isAutomatedBrowser({ webdriver: true })).toBe(true);
	});

	test("is false for a person's browser, and where there is no navigator", () => {
		expect(isAutomatedBrowser({ webdriver: false })).toBe(false);
		expect(isAutomatedBrowser(undefined)).toBe(false);
	});
});
