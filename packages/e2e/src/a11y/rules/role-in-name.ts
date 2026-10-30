import type { Role } from "../../driver/driver.types";
import { accessibleName } from "../speech";
import { describe, issue, type Rule } from "./rule.context";

const WORDS: Partial<Record<Role, RegExp>> = {
	button: /\b(button|btn)\b/i,
	image: /\b(image|icon)\b/i,
};

/** The screen reader already says the role ("Save, button"); a name that says it too is announced twice. */
export const roleInName: Rule = (_snapshot, ctx) =>
	ctx.reachable.flatMap((el) => {
		const pattern = WORDS[el.role];
		const name = pattern ? accessibleName(el, ctx.platform) : undefined;
		const hit = name ? pattern?.exec(name)?.[0] : undefined;
		return hit
			? [
					issue(
						"role-in-name",
						"warning",
						el,
						`${describe(el)} name "${name}" contains its role word "${hit}", announced twice`
					),
				]
			: [];
	});
