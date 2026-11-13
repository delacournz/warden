import { describe, expect, test } from "bun:test";
import { parseArgs } from "./args";

describe("parseArgs", () => {
	test("a suite name with options", () => {
		expect(parseArgs(["login", "--model", "m", "--udid", "U", "--out", "/o", "--json"])).toEqual({
			success: true,
			data: { kind: "run", suite: "login", model: "m", udid: "U", out: "/o", json: true },
		});
	});

	test("--tools narrows to known tools, deduplicated", () => {
		const parsed = parseArgs(["login", "--tools", "argent,agent-device,argent"]);
		expect(parsed).toEqual({
			success: true,
			data: { kind: "run", suite: "login", tools: ["argent", "agent-device"], json: false },
		});
		expect(parseArgs(["login", "--tools", "maestro"]).success).toBe(false);
		expect(parseArgs(["login", "--tools"]).success).toBe(false);
	});

	test("--reps runs each tool N times (1..20)", () => {
		expect(parseArgs(["login", "--reps", "3"])).toEqual({
			success: true,
			data: { kind: "run", suite: "login", reps: 3, json: false },
		});
		for (const bad of ["0", "21", "2.5", "x", "-1"]) expect(parseArgs(["login", "--reps", bad]).success).toBe(false);
		expect(parseArgs(["login", "--reps"]).success).toBe(false);
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
