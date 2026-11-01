import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { iosMemoryParser } from "./ios-memory";

const fx = (name: string) => readFileSync(join(import.meta.dir, "..", "..", "fixtures", name), "utf8");

describe("sizeToKb", () => {
	test.each([
		["512K", 512],
		["168.4M", 172442],
		["1.1G", 1153434],
	])("%s", (text, kb) => expect(iosMemoryParser.sizeToKb(text)).toBe(kb));
	test("junk", () => expect(iosMemoryParser.sizeToKb("12")).toBeUndefined());
});

describe("parseLeaks", () => {
	test("count, bytes and the leaked types by instance count", () => {
		expect(iosMemoryParser.parseLeaks(fx("leaks-summary.txt"))).toEqual({
			leakCount: 3,
			leakedBytes: 224,
			types: [
				{ type: "NSMutableArray", count: 2 },
				{ type: "malloc<64>", count: 1 },
			],
		});
	});
	test("no leaks", () => {
		expect(iosMemoryParser.parseLeaks(fx("leaks-clean.txt"))).toEqual({ leakCount: 0, leakedBytes: 0, types: [] });
	});
	test("tool failure: undefined", () =>
		expect(iosMemoryParser.parseLeaks("leaks: cannot examine process 845")).toBeUndefined());
});

describe("parseVmmap", () => {
	test("footprint, peak and the top 5 regions by dirty size", () => {
		const v = iosMemoryParser.parseVmmap(fx("vmmap-summary.txt"));
		expect(v?.footprintKb).toBe(172442);
		expect(v?.footprintPeakKb).toBe(186266);
		expect(v?.regions.map((r) => r.type)).toEqual([
			"MALLOC_SMALL",
			"IOSurface",
			"MALLOC_LARGE",
			"MALLOC_TINY",
			"__DATA",
		]);
		expect(v?.regions[0]).toEqual({ type: "MALLOC_SMALL", residentKb: 76390, dirtyKb: 74650, swappedKb: 2355 });
	});
	test("no footprint: undefined", () => expect(iosMemoryParser.parseVmmap("No such process")).toBeUndefined());
});
