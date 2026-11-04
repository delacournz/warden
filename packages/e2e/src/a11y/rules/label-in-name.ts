import type { Element, Platform } from "../../driver/driver.types";
import { accessibleName, isActionable } from "../speech";
import { describe, issue, type Rule } from "./rule.context";

/** Case, whitespace and punctuation do not matter: a name may join parts with commas that the visible text lacks. */
const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

function visibleText(el: Element, platform: Platform): string {
	const own = platform === "android" ? el.text?.trim() : undefined;
	if (own) return own;
	const parts: string[] = [];
	const walk = (e: Element): void => {
		for (const c of e.children) {
			if (c.hidden) continue;
			if (c.role === "text") {
				const t = (c.text ?? c.label ?? c.value)?.trim();
				if (t) parts.push(t);
			} else walk(c);
		}
	};
	walk(el);
	return parts.join(" ");
}

/**
 * 2.5.3: voice-control users say what they see. When the accessible name is a separate label (content-desc /
 * accessibilityLabel) and the control shows other text, the visible text must be inside the name. Names built from
 * the visible text itself can't fail.
 */
export const labelInName: Rule = (_snapshot, ctx) =>
	ctx.reachable.flatMap((el) => {
		if (!isActionable(el, ctx.platform) || !el.label?.trim()) return [];
		const visible = visibleText(el, ctx.platform);
		const name = accessibleName(el, ctx.platform);
		if (!visible || !name || norm(name).includes(norm(visible))) return [];
		return [issue("label-in-name", "error", el, `${describe(el)} shows "${visible}" but is named "${name}"`, "2.5.3")];
	});
