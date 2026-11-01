import type { Point } from "@delacour/warden-driver/driver.types";
import { E2eError } from "@delacour/warden-driver/e2e-error";
import { actionGeometry, type Momentum, PATH_MS, PINCH_MS, ROTATE_MS, type SwipeDirection } from "./actions";
import { Runtime, type ScreenHost } from "./context";
import { type ActionOptions, Locator, locatorSupport, type ScrollOptions } from "./locator";
import { queryBuilder, type RoleOptions, type TestIdOptions, type TextQueryOptions } from "./queries";
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

/** The `screen` object over one host; its members are arrow properties so specs may destructure them. */
class ScreenImpl implements Screen {
	private readonly rt: Runtime;

	constructor(private readonly host: ScreenHost) {
		this.rt = new Runtime(host);
	}

	readonly getByTestId = (id: TextMatch, options?: TestIdOptions): Locator =>
		this.lazy(queryBuilder.testIdQuery(id, options));

	readonly getByText = (text: TextMatch, options?: TextQueryOptions): Locator =>
		this.lazy(queryBuilder.textQuery("text", text, options));

	readonly getByLabel = (text: TextMatch, options?: TextQueryOptions): Locator =>
		this.lazy(queryBuilder.textQuery("label", text, options));

	readonly getByPlaceholder = (text: TextMatch, options?: TextQueryOptions): Locator =>
		this.lazy(queryBuilder.textQuery("placeholder", text, options));

	readonly getByValue = (value: TextMatch, options?: TextQueryOptions): Locator =>
		this.lazy(queryBuilder.textQuery("value", value, options));

	readonly getByRole = (
		role: QueryRole,
		nameOrOptions?: TextMatch | RoleOptions,
		options?: Omit<RoleOptions, "name">
	): Locator => this.lazy(queryBuilder.roleQuery(role, nameOrOptions, options));

	readonly locator = (selector: string): Locator => new Locator(queryBuilder.selectorExpression(selector), this.rt);

	readonly tapAt = async (point: Point): Promise<void> => {
		if (!this.isFinitePoint(point))
			throw new E2eError("INVALID_ARGUMENT", `tapAt needs finite x and y, got ${JSON.stringify(point)}`);
		return this.rt.step(`tapAt (${point.x}, ${point.y})`, async () => {
			const driver = await this.host.driver();
			this.rt.drive("tapAt", await driver.tap(point));
		});
	};

	readonly swipe = async (options: ScreenSwipeOptions): Promise<void> => {
		this.assertSwipeShape(options);
		return this.rt.step("swipe", async () => {
			if ("direction" in options) {
				const observed = await this.rt.observe();
				const vector = actionGeometry.swipeVector(
					options.direction,
					actionGeometry.screenRect(observed.snapshot.screen),
					options.momentum
				);
				this.rt.drive("swipe", await observed.driver.swipe(vector.from, vector.to, vector.options));
				return;
			}
			if (!this.isFinitePoint(options.from) || !this.isFinitePoint(options.to)) {
				throw new E2eError("INVALID_ARGUMENT", "swipe needs finite coordinates for from and to");
			}
			const driver = await this.host.driver();
			const opts = options.durationMs === undefined ? undefined : { durationMs: options.durationMs };
			this.rt.drive("swipe", await driver.swipe(options.from, options.to, opts));
		});
	};

	readonly gesture: ScreenGestures = {
		pinch: async (options) => {
			actionGeometry.assertScale(options.scale);
			return this.rt.step(`pinch ×${options.scale}`, async () => {
				const observed = await this.rt.observe();
				const rect = actionGeometry.screenRect(observed.snapshot.screen);
				actionGeometry.requireGesture(observed.driver, "pinch", "screen.gesture.pinch");
				this.rt.drive(
					"pinch",
					await observed.driver.pinch(options.center ?? actionGeometry.centreOf(rect), options.scale, {
						durationMs: options.durationMs ?? PINCH_MS,
						radius: options.radius ?? actionGeometry.pinchRadius(rect, options.scale, observed.snapshot.screen),
					})
				);
			});
		},

		rotate: async (options) => {
			actionGeometry.assertDegrees(options.degrees);
			return this.rt.step(`rotate ${options.degrees}°`, async () => {
				const observed = await this.rt.observe();
				const rect = actionGeometry.screenRect(observed.snapshot.screen);
				actionGeometry.requireGesture(observed.driver, "pinch", "screen.gesture.rotate");
				this.rt.drive(
					"rotate",
					await observed.driver.rotate(options.center ?? actionGeometry.centreOf(rect), options.degrees, {
						durationMs: options.durationMs ?? ROTATE_MS,
						radius: options.radius ?? actionGeometry.rotateRadius(rect, observed.snapshot.screen),
					})
				);
			});
		},

		path: async (options) => {
			const { paths } = options;
			if (paths.length < 1 || paths.length > 2) {
				throw new E2eError("INVALID_ARGUMENT", `gesture.path takes 1 or 2 paths, got ${paths.length}`);
			}
			if (paths.some((points) => points.length < 1 || !points.every((point) => this.isFinitePoint(point)))) {
				throw new E2eError(
					"INVALID_ARGUMENT",
					"gesture.path needs at least one point per path, all with finite x and y"
				);
			}
			return this.rt.step(`gesture path (${paths.length} ${paths.length === 1 ? "finger" : "fingers"})`, async () => {
				const driver = await this.host.driver();
				actionGeometry.requireGesture(driver, "path", "screen.gesture.path", paths.length);
				this.rt.drive(
					"gesture",
					await driver.gesture(
						paths.map((points) => ({ points: [...points] })),
						{ durationMs: options.durationMs ?? PATH_MS }
					)
				);
			});
		},

		swipe: (options) => this.swipe(options),
	};

	readonly scrollUntilVisible = (target: Locator, options?: ScrollOptions): Promise<void> =>
		locatorSupport.scrollUntilVisible(this.rt, target, options);

	private lazy(query: Query): Locator {
		return new Locator({ kind: "query", query }, this.rt);
	}

	private assertSwipeShape(options: ScreenSwipeOptions): void {
		const keys = Object.keys(options);
		const allowed = "direction" in options ? ["direction", "momentum"] : ["from", "to", "durationMs"];
		const unknown = keys.filter((key) => !allowed.includes(key));
		if (unknown.length > 0 || keys.length === 0 || ("direction" in options && "from" in options)) {
			throw new E2eError(
				"INVALID_ARGUMENT",
				"swipe takes either { direction, momentum? } or { from, to, durationMs? }, not a mix"
			);
		}
	}

	private isFinitePoint(point: Point): boolean {
		return Number.isFinite(point.x) && Number.isFinite(point.y);
	}
}

/** Builds the `screen` of the spec API over a host. */
export class ScreenFactory {
	createScreen(host: ScreenHost): Screen {
		return new ScreenImpl(host);
	}
}

export const screenFactory = new ScreenFactory();
