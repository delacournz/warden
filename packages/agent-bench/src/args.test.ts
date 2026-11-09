import { describe, expect, test } from "bun:test";
import { parseArgs } from "./args";

describe("parseArgs", () => {
	test("a suite name with options", () => {
		expect(parseArgs(["login", "--model", "m", "--udid", "U", "--out", "/o", "--json"])).toEqual({
			success: true,
			data: { kind: "run", suite: "login", model: "m", udid: "U", out: "/o", json: true },
		});
	});

	test("list and help", () => {
		expect(parseArgs(["list"])).toEqual({ success: true, data: { kind: "list" } });
		expect(parseArgs([])).toEqual({ success: true, data: { kind: "help" } });
		expect(parseArgs(["--help"])).toEqual({ success: true, data: { kind: "help" } });
	});

	test("an unknown flag or a flag without its value is an error", () => {
		expect(parseArgs(["login", "--nope"]).success).toBe(false);
		expect(parseArgs(["login", "--model"]).success).toBe(false);
		expect(parseArgs(["login", "extra"]).success).toBe(false);
	});
});
