import type { Point } from "../driver/driver.types";
import { E2eError } from "../errors";
import { type Momentum, type SwipeDirection, screenRect, swipeVector } from "./actions";
import { Runtime, type ScreenHost } from "./context";
import { type ActionOptions, Locator, type ScrollOptions, scrollUntilVisible } from "./locator";
import {
	type RoleOptions,
	roleQuery,
	selectorExpression,
	type TestIdOptions,
	type TextQueryOptions,
	testIdQuery,
	textQuery,
} from "./queries";
import type { Query } from "./query";
import type { QueryRole } from "./roles";
import type { TextMatch } from "./text";

export type ScreenSwipeOptions =
	| { direction: SwipeDirection; momentum?: Momentum }
	| { from: Point; to: Point; durationMs?: number };

/** The `screen` of the spec API: lazy queries over the device, plus viewport-level gestures. */
export type Screen = {
	getByTestId(id: TextMatch, options?: TestIdOptions): Locator;
	getByText(text: TextMatch, options?: TextQueryOptions): Locator;
	getByLabel(text: TextMatch, options?: TextQueryOptions): Locator;
	getByPlaceholder(text: TextMatch, options?: TextQueryOptions): Locator;
	getByValue(value: TextMatch, options?: TextQueryOptions): Locator;
	getByRole(role: QueryRole, nameOrOptions?: TextMatch | RoleOptions, options?: Omit<RoleOptions, "name">): Locator;
	/** the agent-CLI selector grammar: `locator("id=sign-in role=button nth=1")` */
	locator(selector: string): Locator;
	tapAt(point: Point, options?: ActionOptions): Promise<void>;
	swipe(options: ScreenSwipeOptions): Promise<void>;
	scrollUntilVisible(target: Locator, options?: ScrollOptions): Promise<void>;
};

function isFinitePoint(point: Point): boolean {
	return Number.isFinite(point.x) && Number.isFinite(point.y);
}

export function createScreen(host: ScreenHost): Screen {
	const rt = new Runtime(host);
	const lazy = (query: Query): Locator => new Locator({ kind: "query", query }, rt);

	return {
		getByTestId: (id, options) => lazy(testIdQuery(id, options)),
		getByText: (text, options) => lazy(textQuery("text", text, options)),
		getByLabel: (text, options) => lazy(textQuery("label", text, options)),
		getByPlaceholder: (text, options) => lazy(textQuery("placeholder", text, options)),
		getByValue: (value, options) => lazy(textQuery("value", value, options)),
		getByRole: (role, nameOrOptions, options) => lazy(roleQuery(role, nameOrOptions, options)),
		locator: (selector) => new Locator(selectorExpression(selector), rt),

		async tapAt(point) {
			if (!isFinitePoint(point))
				throw new E2eError("INVALID_ARGUMENT", `tapAt needs finite x and y, got ${JSON.stringify(point)}`);
			return rt.step(`tapAt (${point.x}, ${point.y})`, async () => {
				const driver = await host.driver();
				rt.drive("tapAt", await driver.tap(point));
			});
		},

		async swipe(options) {
			const keys = Object.keys(options);
			const allowed = "direction" in options ? ["direction", "momentum"] : ["from", "to", "durationMs"];
			const unknown = keys.filter((key) => !allowed.includes(key));
			if (unknown.length > 0 || keys.length === 0 || ("direction" in options && "from" in options)) {
				throw new E2eError(
					"INVALID_ARGUMENT",
					"swipe takes either { direction, momentum? } or { from, to, durationMs? }, not a mix"
				);
			}
			return rt.step("swipe", async () => {
				if ("direction" in options) {
					const observed = await rt.observe();
					const vector = swipeVector(options.direction, screenRect(observed.snapshot.screen), options.momentum);
					rt.drive("swipe", await observed.driver.swipe(vector.from, vector.to, vector.options));
					return;
				}
				if (!isFinitePoint(options.from) || !isFinitePoint(options.to)) {
					throw new E2eError("INVALID_ARGUMENT", "swipe needs finite coordinates for from and to");
				}
				const driver = await host.driver();
				const opts = options.durationMs === undefined ? undefined : { durationMs: options.durationMs };
				rt.drive("swipe", await driver.swipe(options.from, options.to, opts));
			});
		},

		scrollUntilVisible: (target, options) => scrollUntilVisible(rt, target, options),
	};
}
