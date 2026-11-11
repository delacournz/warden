import { A11Y_RULE_IDS } from "@delacour/warden-core/a11y/a11y.config";
import type { A11yIgnore, A11yRuleId, A11ySeverity } from "@delacour/warden-e2e/a11y/a11y.types";
import { err, ok, type Result } from "@delacour/warden-types/result";

const isRule = (v: string): v is A11yRuleId => (A11Y_RULE_IDS as readonly string[]).includes(v);
const RULES = A11Y_RULE_IDS.join(", ");

export type AuditFlags = { rules?: A11yRuleId[]; ignore: A11yIgnore[]; minSeverity: A11ySeverity };

/** Validates each `--rule` id, in order; the first unknown one is the error. */
function parseRules(raw: readonly string[]): Result<A11yRuleId[]> {
	const rules: A11yRuleId[] = [];
	for (const rule of raw) {
		if (!isRule(rule)) return err(`unknown rule "${rule}" (use ${RULES})`);
		rules.push(rule);
	}
	return ok(rules);
}

/** One `--ignore <rule[:identifier]>` spec. */
function parseIgnoreSpec(spec: string): Result<A11yIgnore> {
	const at = spec.indexOf(":");
	const rule = at === -1 ? spec : spec.slice(0, at);
	const identifier = at === -1 ? undefined : spec.slice(at + 1);
	if (!isRule(rule)) return err(`unknown rule "${rule}" in --ignore ${spec} (use ${RULES})`);
	if (identifier === "") return err(`--ignore ${spec} has an empty identifier (use <rule> or <rule>:<identifier>)`);
	return ok(identifier === undefined ? { rule } : { rule, identifier });
}

/** Validates each `--ignore` spec, in order; the first bad one is the error. */
function parseIgnores(raw: readonly string[]): Result<A11yIgnore[]> {
	const ignore: A11yIgnore[] = [];
	for (const spec of raw) {
		const parsed = parseIgnoreSpec(spec);
		if (!parsed.success) return parsed;
		ignore.push(parsed.data);
	}
	return ok(ignore);
}

/** `--rule <id>…`, `--ignore <rule[:identifier]>…`, `--min-severity error|warning` (default `error`). */
export function parseAuditFlags(opts: {
	rule?: string[];
	ignore?: string[];
	minSeverity?: string;
}): Result<AuditFlags> {
	const rules = parseRules(opts.rule ?? []);
	if (!rules.success) return rules;
	const ignore = parseIgnores(opts.ignore ?? []);
	if (!ignore.success) return ignore;
	const minSeverity = opts.minSeverity ?? "error";
	if (minSeverity !== "error" && minSeverity !== "warning") {
		return err(`--min-severity must be error or warning, got "${minSeverity}"`);
	}
	return ok({ ...(rules.data.length > 0 ? { rules: rules.data } : {}), ignore: ignore.data, minSeverity });
}

/** `--since <cursor>`: the opaque whole number an earlier `announcements` / `spoken` printed. */
export function parseCursor(raw: string | undefined): Result<number | undefined> {
	if (raw === undefined) return ok(undefined);
	return /^\d+$/.test(raw) ? ok(Number(raw)) : err(`--since must be a whole number cursor, got "${raw}"`);
}

export type FocusStep = "next" | "prev" | "activate" | "status";

export function parseFocusStep(raw: string | undefined): Result<FocusStep> {
	return raw === "next" || raw === "prev" || raw === "activate" || raw === "status"
		? ok(raw)
		: err("a11y focus needs next, prev, activate or status");
}
