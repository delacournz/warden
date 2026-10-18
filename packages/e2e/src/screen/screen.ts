import type { Point } from "../driver/driver.types";
import { E2eError } from "../errors";
import {
	assertDegrees,
	assertScale,
	centreOf,
	type Momentum,
	PATH_MS,
	PINCH_MS,
	pinchRadius,
	ROTATE_MS,
	requireGesture,
	rotateRadius,
	type SwipeDirection,
	screenRect,
	swipeVector,
} from "./actions";
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

export type ScreenPinchOptions = { scale: number; center?: Point; radius?: number; durationMs?: number };
export type ScreenRotateOptions = { degrees: number; center?: Point; radius?: number; durationMs?: number };
/**
 * `paths` are 1-2 fingers' routes in screen points, each with at least one finite point (give two or more for a
 * real path; a single point is a held touch). More fingers than the driver's `capabilities.maxPointers` is `INVALID_ARGUMENT`.
 */
export type ScreenPathOptions = { paths: readonly (readonly Point[])[]; durationMs?: number };

/** Viewport-level gestures; `screen.swipe` is the same as `screen.gesture.swipe`. */
export type ScreenGestures = {
	/** pinch about the screen centre (or `center`); `scale` above 1 zooms in */
	pinch(options: ScreenPinchOptions): Promise<void>;
	/** rotate about the screen centre (or `center`); positive `degrees` turn clockwise */
	rotate(options: ScreenRotateOptions): Promise<void>;
	/** replay 1-2 finger paths on one timeline; no observation, coordinates are used as given */
	path(options: ScreenPathOptions): Promise<void>;
	swipe(options: ScreenSwipeOptions): Promise<void>;
};

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
	gesture: ScreenGestures;
	scrollUntilVisible(target: Locator, options?: ScrollOptions): Promise<void>;
};

function isFinitePoint(point: Point): boolean {
	return Number.isFinite(point.x) && Number.isFinite(point.y);
}

export function createScreen(host: ScreenHost): Screen {
	const rt = new Runtime(host);
	const lazy = (query: Query): Locator => new Locator({ kind: "query", query }, rt);

	const swipe = async (options: ScreenSwipeOptions): Promise<void> => {
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
	};

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

		swipe,

		gesture: {
			async pinch(options) {
				assertScale(options.scale);
				return rt.step(`pinch ×${options.scale}`, async () => {
					const observed = await rt.observe();
					const rect = screenRect(observed.snapshot.screen);
					requireGesture(observed.driver, "pinch", "screen.gesture.pinch");
					rt.drive(
						"pinch",
						await observed.driver.pinch(options.center ?? centreOf(rect), options.scale, {
							durationMs: options.durationMs ?? PINCH_MS,
							radius: options.radius ?? pinchRadius(rect, options.scale, observed.snapshot.screen),
						})
					);
				});
			},

			async rotate(options) {
				assertDegrees(options.degrees);
				return rt.step(`rotate ${options.degrees}°`, async () => {
					const observed = await rt.observe();
					const rect = screenRect(observed.snapshot.screen);
					requireGesture(observed.driver, "pinch", "screen.gesture.rotate");
					rt.drive(
						"rotate",
						await observed.driver.rotate(options.center ?? centreOf(rect), options.degrees, {
							durationMs: options.durationMs ?? ROTATE_MS,
							radius: options.radius ?? rotateRadius(rect, observed.snapshot.screen),
						})
					);
				});
			},

			async path(options) {
				const { paths } = options;
				if (paths.length < 1 || paths.length > 2) {
					throw new E2eError("INVALID_ARGUMENT", `gesture.path takes 1 or 2 paths, got ${paths.length}`);
				}
				if (paths.some((points) => points.length < 1 || !points.every(isFinitePoint))) {
					throw new E2eError(
						"INVALID_ARGUMENT",
						"gesture.path needs at least one point per path, all with finite x and y"
					);
				}
				return rt.step(`gesture path (${paths.length} ${paths.length === 1 ? "finger" : "fingers"})`, async () => {
					const driver = await host.driver();
					requireGesture(driver, "path", "screen.gesture.path", paths.length);
					rt.drive(
						"gesture",
						await driver.gesture(
							paths.map((points) => ({ points: [...points] })),
							{ durationMs: options.durationMs ?? PATH_MS }
						)
					);
				});
			},

			swipe,
		},

		scrollUntilVisible: (target, options) => scrollUntilVisible(rt, target, options),
	};
}
