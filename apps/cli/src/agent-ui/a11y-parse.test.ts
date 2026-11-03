import { describe, expect, test } from "bun:test";
import { parseAuditFlags, parseCursor, parseFocusStep } from "./a11y-parse";

describe("parseAuditFlags", () => {
	test("defaults: every rule, nothing ignored, fail on error", () => {
		expect(parseAuditFlags({})).toEqual({ success: true, data: { ignore: [], minSeverity: "error" } });
	});

	test("--rule and --ignore repeat; --ignore takes rule:identifier", () => {
		expect(
			parseAuditFlags({
				rule: ["missing-name", "target-size"],
				ignore: ["duplicate-name", "label-in-name:search:field"],
				minSeverity: "warning",
			})
		).toEqual({
			success: true,
			data: {
				rules: ["missing-name", "target-size"],
				ignore: [{ rule: "duplicate-name" }, { rule: "label-in-name", identifier: "search:field" }],
				minSeverity: "warning",
			},
		});
	});

	test("unknown rule, empty identifier and bad severity are usage errors naming the choices", () => {
		const bad = parseAuditFlags({ rule: ["nope"] });
		expect(bad.success).toBe(false);
		if (!bad.success) expect(bad.error).toContain("missing-name");
		expect(parseAuditFlags({ ignore: ["missing-name:"] }).success).toBe(false);
		expect(parseAuditFlags({ ignore: ["nope:x"] }).success).toBe(false);
		expect(parseAuditFlags({ minSeverity: "info" }).success).toBe(false);
	});
});

describe("parseCursor", () => {
	test("absent is undefined; a whole number passes; anything else fails", () => {
		expect(parseCursor(undefined)).toEqual({ success: true, data: undefined });
		expect(parseCursor("42")).toEqual({ success: true, data: 42 });
		expect(parseCursor("0")).toEqual({ success: true, data: 0 });
		expect(parseCursor("-1").success).toBe(false);
		expect(parseCursor("abc").success).toBe(false);
	});
});

describe("parseFocusStep", () => {
	test("next | prev | activate | status", () => {
		expect(parseFocusStep("next")).toEqual({ success: true, data: "next" });
		expect(parseFocusStep("status")).toEqual({ success: true, data: "status" });
		expect(parseFocusStep(undefined).success).toBe(false);
		expect(parseFocusStep("left").success).toBe(false);
	});
});
