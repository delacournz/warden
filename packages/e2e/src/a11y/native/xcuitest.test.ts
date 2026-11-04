import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type AuditReply, mapAuditIssue, mapAuditReply, XCUITEST_WCAG, xcuitestAudit } from "./xcuitest";

/** Recorded from the iOS Settings app on a simulator through `warden-runner`'s `audit` op. */
const settings: AuditReply = JSON.parse(
	readFileSync(new URL("./fixtures/xcuitest-settings.reply.json", import.meta.url), "utf8")
);

describe("mapAuditReply (recorded from Settings on a simulator)", () => {
	const mapped = mapAuditReply(settings);

	test("one native xcuitest issue per audit issue", () => {
		expect(mapped.skipped).toBeUndefined();
		expect(mapped.issues).toHaveLength(settings.count);
		for (const issue of mapped.issues) {
			expect(issue.rule).toBe("native");
			expect(issue.source).toBe("xcuitest");
			expect(issue.message.length).toBeGreaterThan(10);
		}
	});

	test("includes the audit type in the message and maps it to WCAG", () => {
		const hit = mapped.issues.find((i) => i.message.startsWith("hitRegion"));
		expect(hit).toMatchObject({ wcag: "2.5.8", severity: "warning", identifier: "Dictate" });
		const trait = mapped.issues.find((i) => i.message.startsWith("trait"));
		expect(trait).toMatchObject({ wcag: "4.1.2", severity: "error" });
	});
});

describe("mapAuditIssue", () => {
	const base = {
		compactDescription: "Label not human-readable",
		detailedDescription: "The accessibilityLabel is not human-readable.",
	};
	test.each([
		["contrast", "1.4.3", "error"],
		["hitRegion", "2.5.8", "warning"],
		["sufficientElementDescription", "4.1.2", "error"],
		["dynamicType", "1.4.4", "warning"],
		["textClipped", "1.4.4", "warning"],
		["elementDetection", "4.1.2", "error"],
		["trait", "4.1.2", "error"],
	])("%s -> WCAG %s, %s", (auditType, wcag, severity) => {
		expect(mapAuditIssue({ auditType, ...base })).toMatchObject({ wcag, severity, source: "xcuitest", rule: "native" });
		expect(XCUITEST_WCAG[auditType]).toBe(wcag);
	});

	test("an element without an identifier is named by its label, and has no identifier field", () => {
		const issue = mapAuditIssue({
			auditType: "sufficientElementDescription",
			...base,
			element: { type: "Other", identifier: "", label: "ada@example.com", frame: { x: 0, y: 0, width: 1, height: 1 } },
		});
		expect(issue.identifier).toBeUndefined();
		expect(issue.message).toEndWith("(ada@example.com)");
	});

	test("an unknown audit type has no WCAG ref", () => {
		expect(mapAuditIssue({ auditType: "future", ...base }).wcag).toBeUndefined();
	});
});

describe("xcuitestAudit", () => {
	const ok = { success: true as const, data: { issues: [], count: 0 } };

	test("skips, never fails, without a runner", async () => {
		const out = await xcuitestAudit({ unavailable: "no runner sources" }, { bundleId: "com.example" });
		expect(out).toEqual({ issues: [], skipped: { source: "xcuitest", reason: "no runner sources" } });
	});

	test("skips without a bundle id", async () => {
		const out = await xcuitestAudit({ audit: async () => ok });
		expect(out.skipped?.reason).toContain("bundle id");
	});

	test("an app that is not running is a skip", async () => {
		const out = await xcuitestAudit(
			{ audit: async () => ({ success: false, error: { code: "E_APP_UNAVAILABLE", message: "x not running" } }) },
			{ bundleId: "com.example" }
		);
		expect(out.skipped).toEqual({ source: "xcuitest", reason: "com.example is not running" });
	});

	test("any other failure is a skip with its message", async () => {
		const out = await xcuitestAudit(
			{ audit: async () => ({ success: false, error: { code: "E_HELPER_CRASHED", message: "runner died" } }) },
			{ bundleId: "com.example" }
		);
		expect(out.skipped?.reason).toBe("runner died");
	});

	test("passes the bundle id and types to the runner and maps the reply", async () => {
		const seen: unknown[] = [];
		const out = await xcuitestAudit(
			{
				audit: async (p) => {
					seen.push(p);
					return { success: true, data: settings };
				},
			},
			{ bundleId: "com.apple.Preferences", types: ["hitRegion"] }
		);
		expect(seen).toEqual([{ bundleId: "com.apple.Preferences", types: ["hitRegion"] }]);
		expect(out.issues).toHaveLength(settings.count);
	});

	test("an unparsable reply is a skip", async () => {
		const out = await xcuitestAudit(
			{ audit: async () => ({ success: true, data: { nope: 1 } }) },
			{ bundleId: "com.example" }
		);
		expect(out.skipped?.reason).toContain("unexpected runner reply");
	});
});
