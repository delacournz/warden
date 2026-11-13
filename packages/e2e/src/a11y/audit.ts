import type { TextSize } from "@delacour/warden-core/conditions/conditions.types";
import { resolveTextSize } from "@delacour/warden-core/conditions/text-size";
import type { Element, Platform, Snapshot } from "../driver/driver.types";
import type { A11yAuditOptions, A11yAuditResult, A11yIssue, A11yRuleId, A11ySeverity } from "./a11y.types";
import { readingOrder } from "./order";
import { duplicateName } from "./rules/duplicate-name";
import { hiddenFocusable } from "./rules/hidden-focusable";
import { imageNoName } from "./rules/image-no-name";
import { labelInName } from "./rules/label-in-name";
import { missingName } from "./rules/missing-name";
import { roleInName } from "./rules/role-in-name";
import type { RuleContext, RuleEntry } from "./rules/rule.context";
import { targetSize, targetSizePlatform } from "./rules/target-size";
import { textClipped } from "./rules/text-clipped";

/** The rules warden runs itself, in report order. `native` findings come from XCUITest / ATF (A11Y-4). */
export const WARDEN_RULES: readonly RuleEntry[] = [
	{ id: "missing-name", run: missingName },
	{ id: "image-no-name", run: imageNoName },
	{ id: "label-in-name", run: labelInName },
	{ id: "target-size", run: targetSize },
	{ id: "target-size-platform", run: targetSizePlatform },
	{ id: "duplicate-name", run: duplicateName },
	{ id: "role-in-name", run: roleInName },
	{ id: "hidden-focusable", run: hiddenFocusable },
	{ id: "text-clipped", run: textClipped },
];

export type RunAuditOptions = A11yAuditOptions & {
	/** active text size; `text-clipped` only runs from `accessibility-medium` (scale 1.6) up */
	textSize?: TextSize;
};

function reachableNodes(snapshot: Snapshot): { reachable: Element[]; parents: Map<Element, Element> } {
	const reachable: Element[] = [];
	const parents = new Map<Element, Element>();
	const walk = (el: Element, parent: Element | undefined): void => {
		if (parent) parents.set(el, parent);
		if (el.hidden) return;
		if (el.a11y?.important !== false) reachable.push(el);
		for (const c of el.children) walk(c, el);
	};
	for (const el of snapshot.elements) walk(el, undefined);
	return { reachable, parents };
}

const SEVERITY_RANK: Record<A11ySeverity, number> = { warning: 0, error: 1 };

const ruleRank = (rule: A11yRuleId): number => {
	const i = WARDEN_RULES.findIndex((r) => r.id === rule);
	return i === -1 ? WARDEN_RULES.length : i;
};

/**
 * Reading-order position of an element id. Nodes a sweep never reaches (the unnamed ones, which is most findings)
 * sit just after the nearest earlier node in tree order that it does reach.
 */
function positions(snapshot: Snapshot, platform: Platform): Map<string, number> {
	const listed = new Map<string, number>();
	readingOrder(snapshot, platform).forEach((a, i) => {
		listed.set(a.id, i);
	});
	const pos = new Map<string, number>();
	let last = -1;
	snapshot.flat.forEach((el, i) => {
		const at = listed.get(el.id);
		if (at !== undefined) {
			pos.set(el.id, at);
			last = at;
		} else pos.set(el.id, last + 0.5 + i / 1_000_000);
	});
	return pos;
}

/** Runs warden's own rules on one snapshot. Native (XCUITest / ATF) findings are added with `mergeIssues`. */
export function runAudit(snapshot: Snapshot, platform: Platform, opts: RunAuditOptions = {}): A11yAuditResult {
	const { reachable, parents } = reachableNodes(snapshot);
	const resolved = opts.textSize === undefined ? undefined : resolveTextSize(opts.textSize);
	const ctx: RuleContext = {
		platform,
		reachable,
		parents,
		...(resolved?.success ? { textScale: resolved.data.scale } : {}),
	};
	const wanted = opts.rules === undefined ? undefined : new Set(opts.rules);
	const found = WARDEN_RULES.filter((r) => wanted === undefined || wanted.has(r.id)).flatMap((r) =>
		r.run(snapshot, ctx)
	);
	const ignore = opts.ignore ?? [];
	const kept = found.filter(
		(i) => !ignore.some((g) => g.rule === i.rule && (g.identifier === undefined || g.identifier === i.identifier))
	);
	const seen = new Set<string>();
	const unique = kept.filter((i) => {
		const k = `${i.rule}\u0000${i.elementId ?? ""}\u0000${i.message}`;
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
	const pos = positions(snapshot, platform);
	const at = (i: A11yIssue): number =>
		i.elementId === undefined ? Number.MAX_SAFE_INTEGER : (pos.get(i.elementId) ?? 0);
	const issues = unique.sort((a, b) => at(a) - at(b) || ruleRank(a.rule) - ruleRank(b.rule));
	return { issues, checked: reachable.length, sources: ["warden"], skipped: [] };
}

/** Issues at or above `minSeverity` (default `error`): what fails `toPassA11yAudit` / `warden ui a11y audit`. */
export function failing(result: A11yAuditResult, minSeverity: A11ySeverity = "error"): A11yIssue[] {
	return result.issues.filter((i) => SEVERITY_RANK[i.severity] >= SEVERITY_RANK[minSeverity]);
}

function elementKey(i: A11yIssue): string | undefined {
	return i.identifier ?? i.elementId;
}

/**
 * Adds another source's findings to a result. A finding on the same element and WCAG criterion as one already there
 * is dropped, and the kept issue notes the other source; findings without a WCAG ref only dedupe on an identical
 * element + message. `skipped` records engines that could not run (never fails the audit).
 */
export function mergeIssues(
	base: A11yAuditResult,
	extra: readonly A11yIssue[],
	skipped: A11yAuditResult["skipped"] = []
): A11yAuditResult {
	const issues = [...base.issues];
	const added: A11yIssue[] = [];
	for (const e of extra) {
		const key = elementKey(e);
		const idx = issues.findIndex(
			(i) =>
				key !== undefined &&
				elementKey(i) === key &&
				(e.wcag !== undefined ? i.wcag === e.wcag : i.rule === e.rule && i.message === e.message)
		);
		const hit = idx === -1 ? undefined : issues[idx];
		if (hit === undefined) {
			added.push(e);
		} else if (hit.source !== e.source && !hit.message.includes(`also reported by ${e.source}`)) {
			issues[idx] = { ...hit, message: `${hit.message} (also reported by ${e.source})` };
		}
	}
	const sources = [...new Set([...base.sources, ...extra.map((e) => e.source)])];
	return {
		issues: [...issues, ...added],
		checked: base.checked,
		sources,
		skipped: [...base.skipped, ...skipped],
	};
}

/** Compact table for test failure output and the CLI: severity, rule, WCAG, element, message. */
export function formatIssues(result: A11yAuditResult, minSeverity: A11ySeverity = "warning"): string {
	const shown = failing(result, minSeverity);
	const head = `a11y audit: ${shown.length} issue${shown.length === 1 ? "" : "s"} in ${result.checked} elements (${result.sources.join(", ")})`;
	const skipped = result.skipped.map((s) => `skipped ${s.source}: ${s.reason}`);
	if (shown.length === 0) return [head, ...skipped].join("\n");
	const rows = shown.map((i) => [i.severity, i.rule, i.wcag ?? "-", i.identifier ?? i.elementId ?? "-", i.message]);
	const widths = [0, 1, 2, 3].map((c) => Math.max(...rows.map((r) => r[c]?.length ?? 0)));
	const lines = rows.map((r) => `${r.map((cell, c) => (c < 4 ? cell.padEnd(widths[c] ?? 0) : cell)).join("  ")}`);
	return [head, ...lines, ...skipped].join("\n");
}
