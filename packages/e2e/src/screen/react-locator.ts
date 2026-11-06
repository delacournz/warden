import type { DevtoolsFacet, TreeOptions } from "../devtools/devtools.types";
import type { Platform, Point, Rect, ScreenInfo } from "../driver/driver.types";
import { matchesText, type TextMatch } from "./text";

/** A component found by `testID` in the React tree, where the accessibility tree had nothing. */
export type ReactMatch = {
	/** window rect in the driver's pixels */
	frame: Rect;
	/** centre of `frame` */
	tapPoint: Point;
	source: "react";
	testId: string;
	/** the component's name (`View`, `Button`, ...) */
	name: string;
	/** the strings rendered inside it, when the React tree reported any */
	text?: string;
};

export type ReactView = { platform: Platform; screen: ScreenInfo };

/** What the React tree said: `answered: false` when it could not be read (no devtools, a failed or timed-out read). */
export type ReactLookup = { answered: true; matches: ReactMatch[] } | { answered: false };

/**
 * Components of the running app whose `testID` matches, with rects in the driver's pixels. This is the fallback for
 * `getByTestId` when the platform hides the view from accessibility (React Native only exposes `testID` to
 * accessibility on some views), and the second opinion on a degraded read. A devtools failure is `answered: false`,
 * kept apart from an empty answer so a caller can tell "absent" from "cannot tell". Android measures in dp but the
 * driver taps in px: `view.screen.scale` converts.
 */
export async function lookUpTestIdViaReact(
	facet: Pick<DevtoolsFacet, "tree">,
	testId: TextMatch,
	view: ReactView,
	options: { screenName?: string; timeoutMs?: number } = {}
): Promise<ReactLookup> {
	const treeOptions: TreeOptions = {
		...(view.platform === "android" ? { pixelRatio: view.screen.scale } : {}),
		...(options.screenName === undefined ? {} : { screen: options.screenName }),
		...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
	};
	let result: Awaited<ReturnType<DevtoolsFacet["tree"]>>;
	try {
		result = await facet.tree(treeOptions);
	} catch {
		return { answered: false };
	}
	if (!result.success) return { answered: false };
	const matches: ReactMatch[] = [];
	for (const component of result.data.components) {
		const { testID, rect } = component;
		if (testID === undefined || rect === undefined || !matchesText(testID, testId)) continue;
		matches.push({
			frame: rect,
			tapPoint: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
			source: "react",
			testId: testID,
			name: component.name,
			...(component.text === undefined ? {} : { text: component.text }),
		});
	}
	return { answered: true, matches };
}

/** `lookUpTestIdViaReact` where any failure means "nothing found", so callers keep their own not-found error. */
export async function locateByTestIdViaReact(
	facet: Pick<DevtoolsFacet, "tree">,
	testId: TextMatch,
	view: ReactView,
	options: { screenName?: string; timeoutMs?: number } = {}
): Promise<ReactMatch[]> {
	const lookup = await lookUpTestIdViaReact(facet, testId, view, options);
	return lookup.answered ? lookup.matches : [];
}

/** Where a tap on `match` lands: `position` is an offset from the frame's top-left corner, else the centre. */
export function reactTapPoint(match: ReactMatch, position?: Point): Point {
	if (position === undefined) return match.tapPoint;
	return { x: match.frame.x + position.x, y: match.frame.y + position.y };
}
