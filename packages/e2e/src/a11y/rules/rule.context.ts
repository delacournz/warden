import type { Element, Platform, Snapshot } from "../../driver/driver.types";
import type { A11yIssue, A11yRuleId } from "../a11y.types";

/** What every rule reads: the snapshot, its platform and (for text-clipped) the active text size. */
export type RuleContext = {
	platform: Platform;
	/** font scale in force (iOS content-size multiplier / Android font_scale); undefined = not set by the run */
	textScale?: number;
	/** nodes a screen reader can reach: not hidden (nor under a hidden node), `important !== false` */
	reachable: readonly Element[];
	parents: ReadonlyMap<Element, Element>;
};

export type Rule = (snapshot: Snapshot, ctx: RuleContext) => A11yIssue[];

export type RuleEntry = { id: A11yRuleId; run: Rule };

/** Points (iOS) / dp (Android) per frame unit: Android frames are px. */
export function unitsPerPoint(snapshot: Snapshot): number {
	return snapshot.platform === "android" ? snapshot.screen.scale || 1 : 1;
}

export function isAncestor(a: Element, b: Element, parents: ReadonlyMap<Element, Element>): boolean {
	for (let p = parents.get(b); p; p = parents.get(p)) if (p === a) return true;
	return false;
}

export function related(a: Element, b: Element, parents: ReadonlyMap<Element, Element>): boolean {
	return a === b || isAncestor(a, b, parents) || isAncestor(b, a, parents);
}

export function issue(
	rule: A11yRuleId,
	severity: A11yIssue["severity"],
	el: Element,
	message: string,
	wcag?: string
): A11yIssue {
	return {
		rule,
		severity,
		source: "warden",
		elementId: el.id,
		message,
		...(wcag === undefined ? {} : { wcag }),
		...(el.identifier === undefined ? {} : { identifier: el.identifier }),
	};
}

export function describe(el: Element): string {
	const what = el.identifier ?? el.label ?? el.text ?? el.rawType;
	return `${el.role} "${what}"`;
}
