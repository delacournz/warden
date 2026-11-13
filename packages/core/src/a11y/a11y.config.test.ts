import { expect, test } from "bun:test";
import { a11yAuditConfigSchema, mergeA11yAuditConfig, parseA11yAuditEnv } from "./a11y.config";

test("accepts ignore / minSeverity / rules", () => {
	const config = {
		ignore: [{ rule: "target-size", identifier: "close" }, { rule: "duplicate-name" }],
		minSeverity: "warning",
		rules: ["missing-name"],
	} as const;
	const ok = a11yAuditConfigSchema.safeParse(config);
	expect(ok.success && ok.data).toEqual({ ...config, ignore: [...config.ignore], rules: [...config.rules] });
});

test("rejects unknown rules, severities and keys", () => {
	expect(a11yAuditConfigSchema.safeParse({ ignore: [{ rule: "nope" }] }).success).toBe(false);
	expect(a11yAuditConfigSchema.safeParse({ minSeverity: "info" }).success).toBe(false);
	expect(a11yAuditConfigSchema.safeParse({ other: 1 }).success).toBe(false);
	expect(a11yAuditConfigSchema.safeParse({ rules: [] }).success).toBe(false);
});

test("suite keys replace top-level keys", () => {
	expect(mergeA11yAuditConfig(undefined, undefined)).toBeUndefined();
	expect(mergeA11yAuditConfig({ minSeverity: "warning", rules: ["missing-name"] }, { minSeverity: "error" })).toEqual({
		minSeverity: "error",
		rules: ["missing-name"],
	});
});

test("env JSON round-trip and errors", () => {
	const r = parseA11yAuditEnv(JSON.stringify({ minSeverity: "warning" }));
	expect(r).toEqual({ success: true, data: { minSeverity: "warning" } });
	expect(parseA11yAuditEnv("{").success).toBe(false);
	const bad = parseA11yAuditEnv(JSON.stringify({ minSeverity: "x" }));
	expect(bad.success).toBe(false);
});
