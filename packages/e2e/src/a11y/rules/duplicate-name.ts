import type { Element } from "../../driver/driver.types";
import { accessibleName, isActionable } from "../speech";
import { describe, issue, type Rule, related } from "./rule.context";

const key = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

const sameFrame = (a: Element, b: Element): boolean =>
	a.frame.x === b.frame.x &&
	a.frame.y === b.frame.y &&
	a.frame.width === b.frame.width &&
	a.frame.height === b.frame.height;

/**
 * 2.4.6: several controls announced identically ("Delete", "Delete") cannot be told apart by ear. One issue per
 * extra control; same identifier or same frame means the same control seen twice, not a duplicate.
 */
export const duplicateName: Rule = (_snapshot, ctx) => {
	const named = ctx.reachable.flatMap((el) => {
		if (!isActionable(el, ctx.platform)) return [];
		const name = accessibleName(el, ctx.platform);
		return name === undefined ? [] : [{ el, name: key(name), raw: name }];
	});
	const out = [];
	const kept: typeof named = [];
	for (const n of named) {
		const first = kept.find(
			(k) =>
				k.name === n.name &&
				!sameFrame(k.el, n.el) &&
				!related(k.el, n.el, ctx.parents) &&
				!(k.el.identifier !== undefined && k.el.identifier === n.el.identifier)
		);
		if (first) {
			out.push(
				issue(
					"duplicate-name",
					"warning",
					n.el,
					`${describe(n.el)} is announced "${n.raw}", the same as ${describe(first.el)}`,
					"2.4.6"
				)
			);
		} else kept.push(n);
	}
	return out;
};
