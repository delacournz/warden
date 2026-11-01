import type { DevtoolsFacet, TreeOptions } from "@delacour/warden-devtools/devtools.types";
import type { Platform, Point, Rect, ScreenInfo } from "@delacour/warden-driver/driver.types";
import { type TextMatch, textMatcher } from "./text";

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
};

export type ReactView = { platform: Platform; screen: ScreenInfo };

export class ReactLocator {
	/**
	 * Components of the running app whose `testID` matches, with rects in the driver's pixels. This is the fallback for
	 * `getByTestId` when the platform hides the view from accessibility (React Native only exposes `testID` to
	 * accessibility on some views). Any devtools failure means "nothing found", so callers keep their own not-found
	 * error. Android measures in dp but the driver taps in px: `view.screen.scale` converts.
	 */
	async locateByTestIdViaReact(
		facet: Pick<DevtoolsFacet, "tree">,
		testId: TextMatch,
		view: ReactView,
		options: { screenName?: string; timeoutMs?: number } = {}
	): Promise<ReactMatch[]> {
		const treeOptions: TreeOptions = {
			...(view.platform === "android" ? { pixelRatio: view.screen.scale } : {}),
			...(options.screenName === undefined ? {} : { screen: options.screenName }),
			...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
		};
		let result: Awaited<ReturnType<DevtoolsFacet["tree"]>>;
		try {
			result = await facet.tree(treeOptions);
		} catch {
			return [];
		}
		if (!result.success) return [];
		const matches: ReactMatch[] = [];
		for (const component of result.data.components) {
			const { testID, rect } = component;
			if (testID === undefined || rect === undefined || !textMatcher.matchesText(testID, testId)) continue;
			matches.push({
				frame: rect,
				tapPoint: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
				source: "react",
				testId: testID,
				name: component.name,
			});
		}
		return matches;
	}

	/** Where a tap on `match` lands: `position` is an offset from the frame's top-left corner, else the centre. */
	reactTapPoint(match: ReactMatch, position?: Point): Point {
		if (position === undefined) return match.tapPoint;
		return { x: match.frame.x + position.x, y: match.frame.y + position.y };
	}
}

export const reactLocator = new ReactLocator();
