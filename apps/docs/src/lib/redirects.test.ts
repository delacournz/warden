import { describe, expect, test } from "bun:test";
import { redirectSlugs, trailingSlashTarget } from "./redirects";

describe("redirectSlugs", () => {
	test("maps a moved guide to its new path", () => {
		expect(redirectSlugs(["guides", "agent-ui"])).toEqual(["agents", "ui"]);
		expect(redirectSlugs(["guides", "specs"])).toEqual(["e2e", "specs"]);
		expect(redirectSlugs(["guides", "run-e2e"])).toEqual(["e2e", "suites"]);
		expect(redirectSlugs(["guides", "bench"])).toEqual(["bench", "run"]);
		expect(redirectSlugs(["guides", "e2e"])).toEqual(["devices", "scripts"]);
	});

	test("returns undefined for a path that never moved", () => {
		expect(redirectSlugs(["reference", "cli"])).toBeUndefined();
		expect(redirectSlugs([])).toBeUndefined();
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
