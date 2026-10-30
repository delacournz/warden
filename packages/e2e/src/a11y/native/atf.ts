import { z } from "zod";
import type { NativeAuditResult } from "../../driver/native-audit";
import type { A11yIssue, A11ySeverity } from "../a11y.types";

/**
 * The Accessibility Test Framework's findings (`warden-uiad` `audit` op, entry class `AtfAudit`) as `A11yIssue`s.
 * Pure: the driver supplies the raw reply, tests feed recorded JSON.
 */

const resultSchema = z.object({
	check: z.string(),
	type: z.enum(["ERROR", "WARNING", "INFO"]),
	resultId: z.number().optional(),
	resourceName: z.string().optional(),
	className: z.string().optional(),
	text: z.string().optional(),
	contentDescription: z.string().optional(),
	bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
	message: z.string().optional(),
});

export const atfReplySchema = z.object({
	checks: z.number(),
	ignored: z.number().optional(),
	contrast: z.boolean().optional(),
	hierarchyMs: z.number().optional(),
	checksMs: z.number().optional(),
	failedChecks: z.array(z.string()).optional(),
	results: z.array(resultSchema),
});

export type AtfReply = z.infer<typeof atfReplySchema>;
export type AtfResult = AtfReply["results"][number];

/** WCAG 2.2 success criterion per ATF check (class name without the `Check` suffix). */
export const ATF_WCAG: Readonly<Record<string, string>> = {
	TouchTargetSize: "2.5.8",
	SpeakableTextPresent: "4.1.2",
	TextContrast: "1.4.3",
	ImageContrast: "1.4.11",
	DuplicateSpeakableText: "2.4.6",
	EditableContentDesc: "4.1.2",
	TraversalOrder: "2.4.3",
	DuplicateClickableBounds: "4.1.2",
	ClickableSpan: "2.4.4",
	LinkPurposeUnclear: "2.4.4",
	TextSize: "1.4.4",
	ClassName: "4.1.2",
	RedundantDescription: "1.1.1",
};

/** Checks that only ever advise (the platform guidance, not a WCAG failure). */
const ALWAYS_WARNING: ReadonlySet<string> = new Set(["RedundantDescription"]);

export function atfCheckName(check: string): string {
	return check.replace(/Check$/, "");
}

const FALLBACK_MESSAGE: Readonly<Record<string, string>> = {
	TouchTargetSize: "touch target is smaller than the recommended size",
	SpeakableTextPresent: "item has no speakable text for a screen reader",
	TextContrast: "text contrast is too low",
	ImageContrast: "image contrast is too low",
	DuplicateSpeakableText: "item shares its speakable text with another item",
	EditableContentDesc: "editable item has a content description that hides its text",
	TraversalOrder: "traversal order does not follow a sensible reading order",
	RedundantDescription: "content description repeats the item's text or type",
};

function severityOf(result: AtfResult): A11ySeverity {
	if (ALWAYS_WARNING.has(atfCheckName(result.check))) return "warning";
	return result.type === "ERROR" ? "error" : "warning";
}

export function mapAtfResult(result: AtfResult): A11yIssue {
	const name = atfCheckName(result.check);
	const wcag = ATF_WCAG[name];
	const detail = result.message?.trim() || FALLBACK_MESSAGE[name] || "accessibility issue";
	const who = result.resourceName ?? result.contentDescription ?? result.text;
	return {
		rule: "native",
		severity: severityOf(result),
		...(wcag !== undefined ? { wcag } : {}),
		source: "atf",
		...(result.resourceName !== undefined ? { identifier: result.resourceName } : {}),
		message: `${name}: ${detail}${who !== undefined ? ` (${who})` : ""}`,
	};
}

/** The raw `audit` reply -> issues; a reply that does not parse is a `skipped` with the reason, never a throw. */
export function mapAtfReply(raw: unknown): NativeAuditResult {
	const parsed = atfReplySchema.safeParse(raw);
	if (!parsed.success)
		return {
			issues: [],
			skipped: { source: "atf", reason: `unexpected ATF reply: ${parsed.error.message.slice(0, 200)}` },
		};
	return { issues: parsed.data.results.map(mapAtfResult) };
}

/** What the driver can do for ATF: run the op (`undefined` = no `warden-uiad` to run it). */
export type AtfPort = {
	run(options: {
		contrast: boolean;
	}): Promise<{ success: true; data: unknown } | { success: false; error: { message: string } } | undefined>;
};

export async function atfAudit(port: AtfPort, options: { contrast?: boolean } = {}): Promise<NativeAuditResult> {
	const res = await port.run({ contrast: options.contrast ?? true });
	if (res === undefined)
		return {
			issues: [],
			skipped: { source: "atf", reason: "warden-uiad is not running (needs Android 8+ and WARDEN_ANDROID_UIAD not 0)" },
		};
	if (!res.success) return { issues: [], skipped: { source: "atf", reason: res.error.message } };
	return mapAtfReply(res.data);
}
