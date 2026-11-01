import { describe, expect, test } from "bun:test";
import type { DeviceRequest } from "@delacour/warden-store/types";
import { physicalAllow } from "./physical-allow";

const IPHONE = "00008140-000A0B0C0D0E0F10";

describe("parsePhysicalIds", () => {
	test("splits a comma list, trims, drops blanks and duplicates", () => {
		expect(physicalAllow.parsePhysicalIds(` ${IPHONE} , R5CT123,, R5CT123 `)).toEqual([IPHONE, "R5CT123"]);
	});

	test("unset or blank is no list", () => {
		expect(physicalAllow.parsePhysicalIds(undefined)).toBeUndefined();
		expect(physicalAllow.parsePhysicalIds("  ")).toBeUndefined();
	});
});

describe("resolvePhysicalAllow", () => {
	test("the env list wins over the repo config", () => {
		expect(physicalAllow.resolvePhysicalAllow({ WARDEN_PHYSICAL_IDS: "A1" }, ["B2"])).toEqual(["A1"]);
	});

	test("the repo config applies without the env", () => {
		expect(physicalAllow.resolvePhysicalAllow({}, ["B2"])).toEqual(["B2"]);
		expect(physicalAllow.resolvePhysicalAllow({ WARDEN_PHYSICAL_IDS: "" }, ["B2"])).toEqual(["B2"]);
	});

	test("neither is no allowlist; an empty config list allows nothing", () => {
		expect(physicalAllow.resolvePhysicalAllow({}, undefined)).toBeUndefined();
		expect(physicalAllow.resolvePhysicalAllow({}, [])).toEqual([]);
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
		expect(physicalAllow.applyPhysicalAllow(req({}), [IPHONE]).physical).toEqual({ allow: [IPHONE] });
	});

	test("named ids win: the request is unchanged", () => {
		const named = req({ ids: ["X"] });
		expect(physicalAllow.applyPhysicalAllow(named, [IPHONE])).toBe(named);
	});

	test("a virtual request or no list is unchanged", () => {
		const virtual = req();
		expect(physicalAllow.applyPhysicalAllow(virtual, [IPHONE])).toBe(virtual);
		const bare = req({});
		expect(physicalAllow.applyPhysicalAllow(bare, undefined)).toBe(bare);
	});
});
