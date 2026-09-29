import { describe, expect, test } from "bun:test";
import { compareVersions, parseVersion } from "./version";

describe("parseVersion", () => {
	test("plain, v-prefixed, prerelease", () => {
		expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, pre: [] });
		expect(parseVersion("v0.10.0")).toEqual({ major: 0, minor: 10, patch: 0, pre: [] });
		expect(parseVersion("1.0.0-rc.2")).toEqual({ major: 1, minor: 0, patch: 0, pre: ["rc", "2"] });
	});

	test("invalid", () => {
		expect(parseVersion("1.2")).toBeUndefined();
		expect(parseVersion("latest")).toBeUndefined();
	});
});

describe("compareVersions", () => {
	test("orders numerically", () => {
		expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
		expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
		expect(compareVersions("1.0.0", "1.0.1")).toBeLessThan(0);
	});

	test("prerelease sorts before release", () => {
		expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
		expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBeLessThan(0);
		expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
	});

	test("unparseable sorts lowest", () => {
		expect(compareVersions("garbage", "0.0.1")).toBeLessThan(0);
	});
});
