import { accessibleName, isFocusTarget } from "../speech";
import { describe, issue, type Rule } from "./rule.context";

/** 4.1.2: a control a screen reader stops on must have a name, or it is announced as just its role. */
export const missingName: Rule = (_snapshot, ctx) =>
	ctx.reachable
		.filter((el) => isFocusTarget(el, ctx.platform) && accessibleName(el, ctx.platform) === undefined)
		.map((el) => issue("missing-name", "error", el, `${describe(el)} has no accessible name`, "4.1.2"));
