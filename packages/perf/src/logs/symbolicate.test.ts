import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { atosArgv, parseAtos, parseDwarfdumpUuid } from "./symbolicate";

const read = (name: string) => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8");

describe("symbolicate", () => {
	test("dwarfdump --uuid", () => {
		expect(parseDwarfdumpUuid(read("dwarfdump-uuid.txt"))).toEqual([
			{
				uuid: "5f6a1c2e-8b3d-4e7a-9c10-2d4b6f8a0e13",
				arch: "arm64",
				path: "/Users/chris/builds/ShopApp.app.dSYM/Contents/Resources/DWARF/ShopApp",
			},
		]);
		expect(parseDwarfdumpUuid("error: not a dSYM")).toEqual([]);
	});

	test("atos argv uses hex load and addresses", () => {
		expect(atosArgv("/d/ShopApp", "arm64", 4294967296, [4299489068, 4299486416])).toEqual([
			"atos",
			"-arch",
			"arm64",
			"-o",
			"/d/ShopApp",
			"-l",
			"0x100000000",
			`0x${(4299489068).toString(16)}`,
			`0x${(4299486416).toString(16)}`,
		]);
	});

	test("atos output pairs by position; bare addresses are unresolved", () => {
		expect(parseAtos(read("atos-out.txt"), 3)).toEqual([
			"-[CartViewController total] (in ShopApp) (CartViewController.m:42)",
			"main (in ShopApp) (main.m:10)",
			undefined,
		]);
		expect(parseAtos("", 2)).toEqual([undefined, undefined]);
	});
});
