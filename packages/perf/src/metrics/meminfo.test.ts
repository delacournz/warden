import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMeminfo } from "./meminfo";

const fx = (name: string) => readFileSync(join(import.meta.dir, "..", "..", "fixtures", name), "utf8");

describe("parseMeminfo", () => {
	test("modern layout: TOTAL PSS/RSS and the top 5 App Summary categories", () => {
		expect(parseMeminfo(fx("dumpsys-meminfo.txt"))).toEqual({
			pid: 4321,
			totalPssKb: 228119,
			totalRssKb: 322432,
			categories: [
				{ name: "Graphics", pssKb: 70616 },
				{ name: "Native Heap", pssKb: 61168 },
				{ name: "Code", pssKb: 55352 },
				{ name: "Java Heap", pssKb: 20548 },
				{ name: "Private Other", pssKb: 10192 },
			],
		});
	});

	test("a row whose number sits under the Rss header (Unknown) is not a PSS category", () => {
		const names = parseMeminfo(fx("dumpsys-meminfo.txt"))?.categories.map((c) => c.name);
		expect(names).not.toContain("Unknown");
	});

	test("legacy layout (no Rss column): TOTAL from the App Summary, no RSS", () => {
		const info = parseMeminfo(fx("dumpsys-meminfo-legacy.txt"));
		expect(info).toMatchObject({ pid: 2210, totalPssKb: 58240 });
		expect(info?.totalRssKb).toBeUndefined();
		expect(info?.categories[0]).toEqual({ name: "Native Heap", pssKb: 20056 });
		expect(info?.categories).toHaveLength(5);
	});

	test("no process: undefined", () => {
		expect(parseMeminfo(fx("dumpsys-meminfo-none.txt"))).toBeUndefined();
	});

	test("garbage: undefined", () => {
		expect(parseMeminfo("")).toBeUndefined();
	});
});
