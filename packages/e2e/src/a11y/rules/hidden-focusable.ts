import type { Element, Snapshot } from "../../driver/driver.types";
import { describe, issue, type Rule } from "./rule.context";

function offScreen(el: Element, screen: Snapshot["screen"]): boolean {
	const f = el.frame;
	return f.x >= screen.width || f.y >= screen.height || f.x + f.width <= 0 || f.y + f.height <= 0;
}

/** A node the platform still marks focusable and important while it is hidden, empty or off screen: a screen reader lands on nothing. */
export const hiddenFocusable: Rule = (snapshot) =>
	snapshot.flat
		.filter((el) => el.a11y?.focusable === true && el.a11y.important !== false)
		.flatMap((el) => {
			const why = el.hidden
				? "hidden"
				: el.frame.width <= 0 || el.frame.height <= 0
					? "zero-size"
					: offScreen(el, snapshot.screen)
						? "off screen"
						: undefined;
			return why ? [issue("hidden-focusable", "warning", el, `${describe(el)} is ${why} but still focusable`)] : [];
		});
