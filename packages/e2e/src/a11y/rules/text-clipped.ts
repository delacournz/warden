import type { Element } from "../../driver/driver.types";
import { describe, issue, type Rule } from "./rule.context";

/** iOS `accessibility-medium`; Android font_scale 1.6 is the same step. */
export const CLIPPING_MIN_SCALE = 1.6;

const ELLIPSIS = /(…|\.\.\.)$/;
const TOLERANCE = 1;

function overflows(el: Element, parent: Element): boolean {
	const f = el.frame;
	const p = parent.frame;
	return (
		f.x < p.x - TOLERANCE ||
		f.y < p.y - TOLERANCE ||
		f.x + f.width > p.x + p.width + TOLERANCE ||
		f.y + f.height > p.y + p.height + TOLERANCE
	);
}

/**
 * 1.4.4: at large text sizes text must still be readable. Runs only when the run's text scale is at least
 * accessibility-medium (`ctx.textScale`). Flags text ending in an ellipsis, and text whose frame spills out of a
 * non-scrolling parent. Scroll containers and the screen-sized root are exempt.
 */
export const textClipped: Rule = (snapshot, ctx) => {
	if (ctx.textScale === undefined || ctx.textScale < CLIPPING_MIN_SCALE) return [];
	return ctx.reachable.flatMap((el) => {
		if (el.role !== "text") return [];
		const content = (el.text ?? el.label ?? el.value)?.trim();
		if (content && ELLIPSIS.test(content))
			return [issue("text-clipped", "warning", el, `${describe(el)} is truncated ("${content}")`, "1.4.4")];
		const parent = ctx.parents.get(el);
		if (!parent || parent.role === "scrollview" || parent.role === "list" || parent.traits.includes("scrollable"))
			return [];
		if (parent.frame.width >= snapshot.screen.width && parent.frame.height >= snapshot.screen.height) return [];
		return overflows(el, parent)
			? [issue("text-clipped", "warning", el, `${describe(el)} overflows its container`, "1.4.4")]
			: [];
	});
};
