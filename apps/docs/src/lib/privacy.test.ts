import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { plainText } from "@/components/rich-text";
import { type Disclosure, PRIVACY, PRIVACY_SECTIONS } from "./privacy";
import { siteUrl } from "./shared";

/**
 * A privacy policy is a list of claims about code, and the code moves without
 * reading it. This file is what makes the claims checkable: each disclosure
 * that names a package is held to that package being installed, each package
 * known to phone home is held to a disclosure naming it, and each feature the
 * PostHog options turn on is held to a sentence about it.
 */

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const DOCS = join(REPO, "apps", "docs");

function dependencies(): string[] {
	const manifest = JSON.parse(readFileSync(join(DOCS, "package.json"), "utf-8")) as {
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};

	return [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})];
}

/** Packages whose job is to send something about the user somewhere. Not exhaustive; the set a reviewer would expect named. */
const PHONES_HOME: readonly RegExp[] = [
	/^posthog/,
	/^@sentry\//,
	/^@amplitude\//,
	/^@segment\//,
	/mixpanel/,
	/^firebase$/,
	/^@bugsnag\//,
	/^@datadog\//,
	/^@vercel\/(analytics|speed-insights)$/,
	/^react-ga/,
	/^logrocket|^@logrocket\//,
	/^newrelic|^@newrelic\//,
];

const DISCLOSURES: readonly Disclosure[] = PRIVACY_SECTIONS.flatMap((section) => section.disclosures ?? []);

/** Every word the page renders, as plain text, for the claims a test can only check by reading. */
const EVERYTHING = plainText(JSON.stringify({ PRIVACY, PRIVACY_SECTIONS }));

const read = (...path: string[]) => readFileSync(join(DOCS, "src", ...path), "utf-8");

describe("the privacy policy's claims", () => {
	test("every disclosed package is actually installed", () => {
		const installed = dependencies();
		const missing = DISCLOSURES.flatMap((row) => (row.source ? [row.source.package] : [])).filter(
			(name) => !installed.includes(name)
		);

		expect(missing).toEqual([]);
	});

	test("every installed package that phones home is disclosed", () => {
		const disclosed = new Set(DISCLOSURES.flatMap((row) => (row.source ? [row.source.package] : [])));
		const undisclosed = dependencies().filter(
			(name) => PHONES_HOME.some((pattern) => pattern.test(name)) && !disclosed.has(name)
		);

		expect(undisclosed).toEqual([]);
	});

	test("names the site by the host it is served from", () => {
		expect(EVERYTHING).toContain(new URL(siteUrl).host);
		expect(EVERYTHING).not.toContain("warden.delacour.co.nz");
	});

	/**
	 * PostHog's host is an environment variable, so it cannot be read out of the
	 * code. What the code does fix is the reverse proxy the policy names.
	 */
	test("names PostHog and the reverse proxy it is reached through", () => {
		expect(EVERYTHING).toContain("PostHog");
		expect(EVERYTHING).toContain("i.delacour.co.nz");
	});

	/** Replay and heatmaps are on in the SDK options, so the policy has to say so; turn either off and this test is the reminder to edit it. */
	test("discloses session recording and heatmaps while the options turn them on", () => {
		const options = read("lib", "analytics", "posthog.ts");

		expect(options).toContain("session_recording:");
		expect(options).not.toContain("disable_session_recording: true");
		expect(options).toContain("capture_heatmaps: true");
		expect(EVERYTHING).toContain("records your session");
		expect(EVERYTHING).toContain("masked");
		expect(EVERYTHING).toContain("heatmaps");
	});

	test("says the site is cookieless until Accept, as the options are", () => {
		const options = read("lib", "analytics", "posthog.ts");

		expect(options).toContain('cookieless_mode: "on_reject"');
		expect(options).toContain("opt_out_capturing_by_default: true");
		expect(EVERYTHING).toContain("without cookies");
	});

	test("says search queries are sent, since the search dialog sends them", () => {
		const dialog = read("components", "search-dialog.tsx");
		const search = DISCLOSURES.find((row) => row.what.startsWith("What you type into search"));

		expect(dialog).toContain('name: "search"');
		expect(search?.to).toContain("PostHog");
	});

	/** No script runs for an agent reading `llms.txt`, so no banner can ask it; the policy has to say it happens. */
	test("discloses the server's agent-fetch event and the user agent it carries", () => {
		const server = read("lib", "analytics", "server.ts");
		const row = DISCLOSURES.find((disclosure) => disclosure.what.startsWith("When a program"));

		expect(server).toContain('"agent-fetch"');
		expect(row).toBeDefined();
		expect(plainText((row as Disclosure).what)).toContain("user agent");
		expect((row as Disclosure).to).toContain("PostHog");
	});

	test("claims self-hosted fonts only while the stylesheet loads none from Google", () => {
		const css = read("styles", "app.css");

		expect(css).not.toContain("fonts.googleapis.com");
		expect(css).toContain("@fontsource");
		expect(EVERYTHING).toContain("fonts are served from our own address");
	});

	test("names the hosts the CLI updates itself from", () => {
		const registry = readFileSync(join(REPO, "apps", "cli", "src", "update", "npm-registry.ts"), "utf-8");
		const helper = readFileSync(join(REPO, "apps", "cli", "src", "update", "fetch-helper.ts"), "utf-8");

		expect(registry).toContain("https://registry.npmjs.org");
		expect(helper).toContain("/releases/download/");
		expect(EVERYTHING).toContain("registry.npmjs.org");
		expect(EVERYTHING).toContain("github.com/delacournz/warden/releases");
	});

	/** The CLI claims to send no telemetry. Hold that to there being no analytics package in it. */
	test("the CLI has no package that phones home", () => {
		const manifest = JSON.parse(readFileSync(join(REPO, "apps", "cli", "package.json"), "utf-8")) as {
			dependencies?: Record<string, string>;
		};
		const phoning = Object.keys(manifest.dependencies ?? {}).filter((name) =>
			PHONES_HOME.some((pattern) => pattern.test(name))
		);

		expect(phoning).toEqual([]);
		expect(EVERYTHING).toContain("collects no telemetry");
	});
});

describe("the privacy policy page", () => {
	test("carries a real date, and not one in the future", () => {
		expect(PRIVACY.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(Date.parse(PRIVACY.updated)).toBeLessThanOrEqual(Date.now());
	});

	test("gives a contact a reader can write to, as a link", () => {
		expect(PRIVACY.contact).toMatch(/^[^\s@]+@[^\s@]+\.[a-z]+$/);
		expect(JSON.stringify(PRIVACY_SECTIONS)).toContain(`(mailto:${PRIVACY.contact})`);
	});

	test("names who is responsible", () => {
		expect(EVERYTHING).toContain(PRIVACY.controller);
	});

	test("has no placeholder left in it", () => {
		expect(EVERYTHING).not.toMatch(/\b(TODO|TBD|PLACEHOLDER|lorem|XXX)\b/i);
	});

	/** Each section is an anchor; the banner lands on `the-website`. */
	test("gives every section a unique, kebab-case id, including the one the banner links to", () => {
		const ids = PRIVACY_SECTIONS.map((section) => section.id);

		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
		expect(ids).toContain("the-website");
		expect(read("components", "consent-banner.tsx")).toContain('hash="the-website"');
	});
});
