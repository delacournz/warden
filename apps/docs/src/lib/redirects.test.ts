import { describe, expect, test } from "bun:test";
import { redirectSlugs } from "./redirects";

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
