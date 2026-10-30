import { z } from "zod";
import type { NativeAuditResult } from "../../driver/native-audit";
import type { A11yIssue, A11ySeverity } from "../a11y.types";

/**
 * The XCUITest accessibility audit (`performAccessibilityAudit`, iOS 17+) as `A11yIssue`s. The runner's `audit` op
 * answers `{issues:[{auditType, compactDescription, detailedDescription, element?}], count, types, ms}`
 * (`native/ios-runner/RunnerCore/.../AuditEncoder.swift`); this file maps it. Pure: a port supplies the reply.
 */

export const AUDIT_TYPES = [
	"contrast",
	"elementDetection",
	"hitRegion",
	"sufficientElementDescription",
	"dynamicType",
	"textClipped",
	"trait",
] as const;
export type XcuitestAuditType = (typeof AUDIT_TYPES)[number];

const issueSchema = z.object({
	auditType: z.string(),
	auditTypes: z.array(z.string()).optional(),
	compactDescription: z.string(),
	detailedDescription: z.string(),
	element: z
		.object({
			type: z.string(),
			identifier: z.string(),
			label: z.string(),
			frame: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
		})
		.optional(),
});

export const auditReplySchema = z.object({
	issues: z.array(issueSchema),
	count: z.number(),
	types: z.array(z.string()).optional(),
	ms: z.number().optional(),
});

export type AuditReply = z.infer<typeof auditReplySchema>;
export type AuditWireIssue = AuditReply["issues"][number];

/** WCAG 2.2 success criterion per audit type. */
export const XCUITEST_WCAG: Readonly<Record<string, string>> = {
	contrast: "1.4.3",
	hitRegion: "2.5.8",
	sufficientElementDescription: "4.1.2",
	dynamicType: "1.4.4",
	textClipped: "1.4.4",
	elementDetection: "4.1.2",
	trait: "4.1.2",
};

/** XCUITest gives no severity: a missing name / role / contrast fails the criterion, size and text-scaling advise. */
const WARNING_TYPES: ReadonlySet<string> = new Set(["hitRegion", "dynamicType", "textClipped"]);

export function mapAuditIssue(issue: AuditWireIssue): A11yIssue {
	const wcag = XCUITEST_WCAG[issue.auditType];
	const severity: A11ySeverity = WARNING_TYPES.has(issue.auditType) ? "warning" : "error";
	const who = issue.element?.identifier || issue.element?.label || undefined;
	const detail = issue.detailedDescription.trim();
	const text =
		detail === "" || detail === issue.compactDescription
			? issue.compactDescription
			: `${issue.compactDescription}. ${detail}`;
	return {
		rule: "native",
		severity,
		...(wcag !== undefined ? { wcag } : {}),
		source: "xcuitest",
		...(issue.element?.identifier ? { identifier: issue.element.identifier } : {}),
		message: `${issue.auditType}: ${text}${who !== undefined ? ` (${who})` : ""}`,
	};
}

export function mapAuditReply(raw: unknown): NativeAuditResult {
	const parsed = auditReplySchema.safeParse(raw);
	if (!parsed.success) {
		return {
			issues: [],
			skipped: { source: "xcuitest", reason: `unexpected runner reply: ${parsed.error.message.slice(0, 200)}` },
		};
	}
	return { issues: parsed.data.issues.map(mapAuditIssue) };
}

/** What the iOS driver gives the audit: the runner `audit` op, or the reason it cannot run. */
export type XcuitestPort = {
	audit(params: {
		bundleId: string;
		types?: readonly XcuitestAuditType[];
	}): Promise<{ success: true; data: unknown } | { success: false; error: { code: string; message: string } }>;
};

export async function xcuitestAudit(
	port: XcuitestPort | { unavailable: string },
	options: { bundleId?: string; types?: readonly XcuitestAuditType[] } = {}
): Promise<NativeAuditResult> {
	const skip = (reason: string): NativeAuditResult => ({ issues: [], skipped: { source: "xcuitest", reason } });
	if ("unavailable" in port) return skip(port.unavailable);
	if (options.bundleId === undefined) return skip("no app bundle id to audit (open the app first)");
	const res = await port.audit({ bundleId: options.bundleId, ...(options.types ? { types: options.types } : {}) });
	if (res.success) return mapAuditReply(res.data);
	if (res.error.code === "E_APP_UNAVAILABLE") return skip(`${options.bundleId} is not running`);
	return skip(res.error.message);
}
