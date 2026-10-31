import type { Element, Platform } from "../../driver/driver.types";
import { accessibleName, isActionable, isFocusTarget } from "../speech";
import { describe, issue, type Rule } from "./rule.context";

/**
 * A scroll container Android marks focusable (React Native's ScrollView does) that nothing can activate. TalkBack
 * walks into its content and never stops on the container, so it needs no name.
 */
function isScrollContainer(el: Element, platform: Platform): boolean {
	const scrolls = el.role === "scrollview" || el.role === "list" || el.traits.includes("scrollable");
	return scrolls && !isActionable(el, platform);
}

/** 4.1.2: a control a screen reader stops on must have a name, or it is announced as just its role. */
export const missingName: Rule = (_snapshot, ctx) =>
	ctx.reachable
		.filter(
			(el) =>
				isFocusTarget(el, ctx.platform) &&
				!isScrollContainer(el, ctx.platform) &&
				accessibleName(el, ctx.platform) === undefined
		)
		.map((el) => issue("missing-name", "error", el, `${describe(el)} has no accessible name`, "4.1.2"));
