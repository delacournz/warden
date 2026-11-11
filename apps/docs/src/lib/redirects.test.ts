import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { markdownTwinTarget, redirectSlugs, rewriteDocsLinks, trailingSlashTarget } from "./redirects";

describe("redirectSlugs", () => {
	test("maps a 2026-10 guide straight to its current tab path", () => {
		expect(redirectSlugs(["guides", "agent-ui"])).toEqual(["sims", "ui"]);
		expect(redirectSlugs(["guides", "specs"])).toEqual(["e2e", "specs"]);
		expect(redirectSlugs(["guides", "run-e2e"])).toEqual(["e2e", "suites"]);
		expect(redirectSlugs(["guides", "bench"])).toEqual(["e2e", "bench", "run"]);
		expect(redirectSlugs(["guides", "e2e"])).toEqual(["sims", "scripts"]);
	});

	test("maps pages that moved into the 2026-11 tabs", () => {
		expect(redirectSlugs([])).toEqual(["getting-started"]);
		expect(redirectSlugs(["quickstart"])).toEqual(["getting-started", "quickstart"]);
		expect(redirectSlugs(["agents"])).toEqual(["sims", "agent-loop"]);
		expect(redirectSlugs(["agents", "ui"])).toEqual(["sims", "ui"]);
		expect(redirectSlugs(["devices", "leases"])).toEqual(["sims", "leases"]);
		expect(redirectSlugs(["e2e", "first-test"])).toEqual(["e2e"]);
		expect(redirectSlugs(["e2e", "biometrics"])).toEqual(["e2e", "conditions", "biometrics"]);
		expect(redirectSlugs(["e2e", "camera"])).toEqual(["e2e", "conditions", "camera"]);
		expect(redirectSlugs(["e2e", "conditions"])).toBeUndefined();
		expect(redirectSlugs(["e2e", "conditions", "network"])).toBeUndefined();
		expect(redirectSlugs(["e2e", "accessibility"])).toBeUndefined();
		expect(redirectSlugs(["bench", "comparison"])).toEqual(["e2e", "bench", "comparison"]);
		expect(redirectSlugs(["release-notes"])).toEqual(["releases"]);
		expect(redirectSlugs(["updating"])).toEqual(["releases", "updating"]);
	});

	test("returns undefined for a path that never moved", () => {
		expect(redirectSlugs(["reference", "cli"])).toBeUndefined();
		expect(redirectSlugs(["e2e", "specs"])).toBeUndefined();
	});
});

describe("rewriteDocsLinks", () => {
	test("rewrites moved links, keeping anchors and .md twins", () => {
		expect(rewriteDocsLinks("[ui](/docs/agents/ui#gesture-pinch)")).toBe("[ui](/docs/sims/ui#gesture-pinch)");
		expect(rewriteDocsLinks("see /docs/quickstart.md")).toBe("see /docs/getting-started/quickstart.md");
		expect(rewriteDocsLinks('href="/docs/installation"')).toBe('href="/docs/getting-started/installation"');
	});

	test("leaves unmoved links, longer slugs and the docs root alone", () => {
		expect(rewriteDocsLinks("/docs/e2e/specs and /docs/reference/cli")).toBe("/docs/e2e/specs and /docs/reference/cli");
		expect(rewriteDocsLinks("/docs/agents-extra")).toBe("/docs/agents-extra");
		expect(rewriteDocsLinks("[docs](/docs)")).toBe("[docs](/docs)");
	});
});

describe("trailingSlashTarget", () => {
	test("strips a trailing slash, keeping the query, as a relative URL", () => {
		expect(trailingSlashTarget(new URL("https://warden.co.nz/docs/e2e/"))).toBe("/docs/e2e");
		expect(trailingSlashTarget(new URL("https://warden.co.nz/docs/?q=1"))).toBe("/docs?q=1");
		expect(trailingSlashTarget(new URL("https://warden.co.nz/docs//"))).toBe("/docs");
	});

	test("leaves the home page and slashless paths alone", () => {
		expect(trailingSlashTarget(new URL("https://warden.co.nz/"))).toBeUndefined();
		expect(trailingSlashTarget(new URL("https://warden.co.nz/docs/e2e"))).toBeUndefined();
	});
});

describe("markdownTwinTarget", () => {
	test("points a docs URL at its .md twin as a relative URL, so a proxy's http origin never leaks", () => {
		expect(markdownTwinTarget(new URL("http://warden.co.nz/docs/sims/ports?x=1"))).toBe("/docs/sims/ports.md?x=1");
		expect(markdownTwinTarget(new URL("http://warden.co.nz/docs"))).toBe("/docs/index.md");
	});
});

describe("site links", () => {
	test("the landing page links straight to live docs pages, never through a redirect", () => {
		const landing = readFileSync(new URL("../routes/index.tsx", import.meta.url), "utf8");
		const targets = [
			...[...landing.matchAll(/<(?:Primary|Secondary)Link to="([^"]*)"/g)].map((m) => m[1] ?? ""),
			...[...landing.matchAll(/_splat: "([^"]*)"/g)].map((m) => m[1] ?? ""),
		];
		expect(targets.length).toBeGreaterThan(0);
		for (const to of targets) expect([to, redirectSlugs(to === "" ? [] : to.split("/"))]).toEqual([to, undefined]);
	});
});
