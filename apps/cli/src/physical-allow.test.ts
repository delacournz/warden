import { describe, expect, test } from "bun:test";
import type { DeviceRequest } from "@delacour/warden-core/types";
import { applyPhysicalAllow, parsePhysicalIds, resolvePhysicalAllow } from "./physical-allow";

const IPHONE = "00008140-000A0B0C0D0E0F10";

describe("parsePhysicalIds", () => {
	test("splits a comma list, trims, drops blanks and duplicates", () => {
		expect(parsePhysicalIds(` ${IPHONE} , R5CT123,, R5CT123 `)).toEqual([IPHONE, "R5CT123"]);
	});

	test("unset or blank is no list", () => {
		expect(parsePhysicalIds(undefined)).toBeUndefined();
		expect(parsePhysicalIds("  ")).toBeUndefined();
	});
});

describe("resolvePhysicalAllow", () => {
	test("the env list wins over the repo config", () => {
		expect(resolvePhysicalAllow({ WARDEN_PHYSICAL_IDS: "A1" }, ["B2"])).toEqual(["A1"]);
	});

	test("the repo config applies without the env", () => {
		expect(resolvePhysicalAllow({}, ["B2"])).toEqual(["B2"]);
		expect(resolvePhysicalAllow({ WARDEN_PHYSICAL_IDS: "" }, ["B2"])).toEqual(["B2"]);
	});

	test("neither is no allowlist; an empty config list allows nothing", () => {
		expect(resolvePhysicalAllow({}, undefined)).toBeUndefined();
		expect(resolvePhysicalAllow({}, [])).toEqual([]);
	});
});

describe("applyPhysicalAllow", () => {
	const req = (physical?: DeviceRequest["physical"]): DeviceRequest => ({
		platform: "ios",
		profile: "iphone-17",
		count: 1,
		max: 1,
		...(physical ? { physical } : {}),
	});

	test("an id-less physical request gets the allowlist", () => {
		expect(applyPhysicalAllow(req({}), [IPHONE]).physical).toEqual({ allow: [IPHONE] });
	});

	test("named ids win: the request is unchanged", () => {
		const named = req({ ids: ["X"] });
		expect(applyPhysicalAllow(named, [IPHONE])).toBe(named);
	});

	test("a virtual request or no list is unchanged", () => {
		const virtual = req();
		expect(applyPhysicalAllow(virtual, [IPHONE])).toBe(virtual);
		const bare = req({});
		expect(applyPhysicalAllow(bare, undefined)).toBe(bare);
	});
});
