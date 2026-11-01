import { describe, expect, test } from "bun:test";
import { updateVersion } from "./version";

describe("parseVersion", () => {
	test("plain, v-prefixed, prerelease", () => {
		expect(updateVersion.parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, pre: [] });
		expect(updateVersion.parseVersion("v0.10.0")).toEqual({ major: 0, minor: 10, patch: 0, pre: [] });
		expect(updateVersion.parseVersion("1.0.0-rc.2")).toEqual({ major: 1, minor: 0, patch: 0, pre: ["rc", "2"] });
	});

	test("invalid", () => {
		expect(updateVersion.parseVersion("1.2")).toBeUndefined();
		expect(updateVersion.parseVersion("latest")).toBeUndefined();
	});
});

describe("compareVersions", () => {
	test("orders numerically", () => {
		expect(updateVersion.compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
		expect(updateVersion.compareVersions("v1.0.0", "1.0.0")).toBe(0);
		expect(updateVersion.compareVersions("1.0.0", "1.0.1")).toBeLessThan(0);
	});

	test("prerelease sorts before release", () => {
		expect(updateVersion.compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
		expect(updateVersion.compareVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBeLessThan(0);
		expect(updateVersion.compareVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
	});

	test("unparseable sorts lowest", () => {
		expect(updateVersion.compareVersions("garbage", "0.0.1")).toBeLessThan(0);
	});
});
