import { describe, expect, test } from "bun:test";
import { findNodeBin } from "./node-bin";

describe("findNodeBin", () => {
	test("the nearest node_modules/.bin/<name> up from the root wins", () => {
		const present = new Set(["/repo/node_modules/.bin/expo", "/repo/apps/a/node_modules/.bin/expo"]);
		expect(findNodeBin("/repo/apps/a", "expo", (p) => present.has(p))).toBe("/repo/apps/a/node_modules/.bin/expo");
	});

	test("a hoisted bin at the repo root is found from a nested app", () => {
		const present = new Set(["/repo/node_modules/.bin/expo"]);
		expect(findNodeBin("/repo/apps/a", "expo", (p) => present.has(p))).toBe("/repo/node_modules/.bin/expo");
	});

	test("the name is part of the match: another bin does not count", () => {
		const present = new Set(["/repo/node_modules/.bin/fingerprint"]);
		expect(findNodeBin("/repo/apps/a", "expo", (p) => present.has(p))).toBeUndefined();
	});

	test("nothing on the way up to / → undefined", () => {
		expect(findNodeBin("/repo/apps/a", "expo", () => false)).toBeUndefined();
	});
});
