import { accessibleName } from "../speech";
import { describe, issue, type Rule } from "./rule.context";

/**
 * 1.1.1: an image a screen reader can reach needs a name. Decorative images (`important: false`, hidden) are not
 * in `ctx.reachable`, so marking one decorative is the fix.
 */
export const imageNoName: Rule = (_snapshot, ctx) =>
	ctx.reachable
		.filter((el) => el.role === "image" && accessibleName(el, ctx.platform) === undefined)
		.map((el) =>
			issue("image-no-name", "error", el, `${describe(el)} has no name (add a label, or mark it decorative)`, "1.1.1")
		);
