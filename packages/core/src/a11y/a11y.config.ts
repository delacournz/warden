import { err, ok, type Result } from "@delacour/warden-types/result";
import { z } from "zod";

/** Every rule id an audit can report (`native` = XCUITest / ATF findings). Keep in step with `A11yRuleId` in `@delacour/warden-e2e`. */
export const A11Y_RULE_IDS = [
	"missing-name",
	"image-no-name",
	"target-size",
	"target-size-platform",
	"duplicate-name",
	"role-in-name",
	"label-in-name",
	"hidden-focusable",
	"text-clipped",
	"native",
] as const;

const ruleId = z.enum(A11Y_RULE_IDS);

/**
 * `a11y` (top level, or per `e2e.<suite>`): how `device.a11yAudit()` / `toPassA11yAudit()` judge a screen.
 * `ignore` drops a rule (everywhere, or only on the element with that `identifier`); `minSeverity` is the lowest
 * severity that fails (default `error`); `rules` limits the audit to those rules.
 */
export const a11yAuditConfigSchema = z
	.object({
		ignore: z.array(z.object({ rule: ruleId, identifier: z.string().min(1).optional() }).strict()).optional(),
		minSeverity: z.enum(["error", "warning"]).optional(),
		rules: z.array(ruleId).min(1).optional(),
	})
	.strict();

export type A11yAuditConfig = z.infer<typeof a11yAuditConfigSchema>;

/** The suite's keys over the top-level ones (a suite's `ignore` / `rules` replace, not extend); undefined when neither is set. */
export function mergeA11yAuditConfig(
	top: A11yAuditConfig | undefined,
	suite: A11yAuditConfig | undefined
): A11yAuditConfig | undefined {
	if (top === undefined && suite === undefined) return undefined;
	return { ...top, ...suite };
}

/** `WARDEN_A11Y_AUDIT`: the JSON `warden e2e` writes. */
export function parseA11yAuditEnv(raw: string): Result<A11yAuditConfig> {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return err("must be JSON");
	}
	const parsed = a11yAuditConfigSchema.safeParse(json);
	if (parsed.success) return ok(parsed.data);
	return err(parsed.error.issues.map((i) => `${i.path.join(".") || "a11y"}: ${i.message}`).join("; "));
}
