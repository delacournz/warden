import type { Driver, Point, Rect, ScreenInfo } from "@delacour/warden-driver/driver.types";
import { actionGeometry, PATH_MS, PINCH_MS, ROTATE_MS } from "@delacour/warden-screen/actions";
import type { Platform } from "@delacour/warden-store/types";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { type ActionResult, finishAction, pointAt, recordTarget, targetLabel, targetOf } from "./act";
import { currentScreen } from "./actions";
import { fail, fromDriver, opError } from "./errors";
import type { RecordTarget } from "./record";
import type { OpOutcome, OpSession } from "./session";

const MAX_PATHS = 2;

const POINT = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/;

/** One `x,y` word as a point, or the reason it is not a usable one (the screen bound is skipped while the size is unknown). */
function parsePathPoint(word: string, screen: ScreenInfo): Point | string {
	const match = POINT.exec(word);
	if (!match) return `"${word}" is not an x,y point`;
	const point = { x: Number(match[1]), y: Number(match[2]) };
	if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return `"${word}" is not finite`;
	const known = screen.width > 0 && screen.height > 0;
	const off = point.x < 0 || point.y < 0 || point.x > screen.width || point.y > screen.height;
	if (known && off) return `${word} is off the screen (${screen.width}x${screen.height})`;
	return point;
}

/** One `--path` per finger, points `x,y` separated by spaces or `;`: 1-2 paths of at least 2 points, all on the screen. */
export function parsePaths(raw: readonly string[], screen: ScreenInfo): Result<Point[][], WardenError> {
	const hint = "warden ui gesture path --path 'x,y x,y …' [--path 'x,y x,y …']";
	const bad = (message: string) => fail(opError("usage", message, { hint }));
	if (raw.length < 1 || raw.length > MAX_PATHS) {
		return bad(`gesture path takes one or two --path (one per finger), got ${raw.length}`);
	}
	const paths: Point[][] = [];
	for (const [index, text] of raw.entries()) {
		const points: Point[] = [];
		for (const word of text.split(/[\s;]+/).filter((part) => part.length > 0)) {
			const point = parsePathPoint(word, screen);
			if (typeof point === "string") return bad(`path ${index + 1}: ${point}`);
			points.push(point);
		}
		if (points.length < 2) return bad(`path ${index + 1} needs at least 2 points`);
		paths.push(points);
	}
	return resultFactory.ok(paths);
}

/** `x,y x,y|x,y x,y`: the recorded form of the paths. */
function pathsText(paths: readonly (readonly Point[])[]): string {
	return paths.map((path) => path.map((point) => `${point.x},${point.y}`).join(" ")).join("|");
}

export type GestureRegion = { rect: Rect; screen: ScreenInfo; center: Point; target?: RecordTarget };

/**
 * Where a two-finger gesture works: an element's visible frame (centre = the middle of what is on screen), or the
 * whole screen around a point target (centre = that point) or no target (centre = the screen centre).
 */
export async function gestureRegion(
	session: OpSession,
	driver: Driver,
	target: string | undefined,
	verify: boolean
): Promise<Result<GestureRegion, WardenError>> {
	const screen = await currentScreen(driver);
	if (!screen.success) return screen;
	const whole = actionGeometry.screenRect(screen.data);
	if (target === undefined || target.trim() === "") {
		return resultFactory.ok({ rect: whole, screen: screen.data, center: { x: whole.width / 2, y: whole.height / 2 } });
	}
	const parsed = targetOf(target);
	if (!parsed.success) return parsed;
	const resolved = await pointAt(session, driver, parsed.data, verify);
	if (!resolved.success) return resolved;
	const where = recordTarget(parsed.data, resolved.data);
	if (!resolved.data.element) {
		return resultFactory.ok({ rect: whole, screen: screen.data, center: resolved.data.point, target: where });
	}
	const rect = actionGeometry.visibleRect(resolved.data.element.frame, screen.data);
	return resultFactory.ok({
		rect,
		screen: screen.data,
		center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
		target: where,
	});
}

/** Fail (`details.driver: E_UNSUPPORTED`) when the driver cannot do `verb`: no two-finger support, or fewer pointers than fingers. */
export function requireCapability(
	driver: Driver,
	platform: Platform,
	verb: string,
	key: "pinch" | "path",
	fingers = 2
): Result<void, WardenError> {
	const { capabilities } = driver;
	if ((key === "path" || capabilities.pinch) && fingers <= capabilities.maxPointers) return resultFactory.ok(undefined);
	return fail(
		opError("failed", `${verb} is not supported on ${platform} here`, {
			hint: "Android needs warden-uiad (Android 8+, WARDEN_ANDROID_UIAD unset)",
			details: { driver: "E_UNSUPPORTED", capability: key },
		})
	);
}

export type TwoFingerParams = {
	/** `@eN` | selector | `x y`; absent = the screen centre */
	target?: string;
	/** how long the gesture takes, in ms */
	durationMs?: number;
	/** finger distance from the centre at the start, in points */
	radius?: number;
	/** re-check an `@eN` against a fresh snapshot first */
	verify?: boolean;
	settleMs?: number;
};

export type PinchParams = TwoFingerParams & {
	/** above 1 spreads the fingers (zoom in), below 1 closes them */
	scale: number;
};
export type PinchResult = ActionResult & { scale: number; center: Point; radius: number; durationMs: number };

export type RotateParams = TwoFingerParams & {
	/** positive degrees turn clockwise */
	degrees: number;
};
export type RotateResult = ActionResult & { degrees: number; center: Point; radius: number; durationMs: number };

type TwoFingerRun = { target: RecordTarget | undefined; center: Point; radius: number; durationMs: number };

/** Region, capability and driver call shared by pinch and rotate. */
async function twoFinger(
	session: OpSession,
	driver: Driver,
	kind: "pinch" | "rotate",
	params: TwoFingerParams,
	amount: number
): Promise<Result<TwoFingerRun, WardenError>> {
	const region = await gestureRegion(session, driver, params.target, params.verify === true);
	if (!region.success) return region;
	const supported = requireCapability(driver, session.device.platform, kind, "pinch");
	if (!supported.success) return supported;
	const { center, rect, screen, target } = region.data;
	const durationMs = params.durationMs ?? (kind === "pinch" ? PINCH_MS : ROTATE_MS);
	const radius =
		params.radius ??
		(kind === "pinch" ? actionGeometry.pinchRadius(rect, amount, screen) : actionGeometry.rotateRadius(rect, screen));
	const driven = fromDriver(
		kind === "pinch"
			? await driver.pinch(center, amount, { durationMs, radius })
			: await driver.rotate(center, amount, { durationMs, radius })
	);
	if (!driven.success) return driven;
	return resultFactory.ok({ target, center, radius, durationMs });
}

const around = (run: TwoFingerRun): string =>
	run.target ? targetLabel(run.target) : `(${Math.round(run.center.x)},${Math.round(run.center.y)})`;

/** `warden ui gesture pinch [target] <scale>`: two fingers around the target (or the screen centre) spread or close. */
export async function pinch(session: OpSession, params: PinchParams): OpOutcome<PinchResult> {
	const driver = await session.driver();
	if (!driver.success) return driver;
	const run = await twoFinger(session, driver.data, "pinch", params, params.scale);
	if (!run.success) return run;
	const { target, center, radius, durationMs } = run.data;
	return finishAction(session, driver.data, params.settleMs, {
		action: "gesture-pinch",
		text: `pinched ${around(run.data)} by ${params.scale}`,
		...(target ? { target } : {}),
		...(params.verify === true && target?.ref !== undefined ? { verified: true } : {}),
		args: {
			scale: params.scale,
			ms: durationMs,
			...(params.radius !== undefined ? { radius: params.radius } : {}),
		},
		extra: { scale: params.scale, center, radius: Math.round(radius * 100) / 100, durationMs },
	});
}

/** `warden ui gesture rotate [target] <degrees>`: two fingers turn around the target (or the screen centre). */
export async function rotate(session: OpSession, params: RotateParams): OpOutcome<RotateResult> {
	const driver = await session.driver();
	if (!driver.success) return driver;
	const run = await twoFinger(session, driver.data, "rotate", params, params.degrees);
	if (!run.success) return run;
	const { target, center, radius, durationMs } = run.data;
	return finishAction(session, driver.data, params.settleMs, {
		action: "gesture-rotate",
		text: `rotated ${around(run.data)} by ${params.degrees} degrees`,
		...(target ? { target } : {}),
		...(params.verify === true && target?.ref !== undefined ? { verified: true } : {}),
		args: {
			degrees: params.degrees,
			ms: durationMs,
			...(params.radius !== undefined ? { radius: params.radius } : {}),
		},
		extra: { degrees: params.degrees, center, radius: Math.round(radius * 100) / 100, durationMs },
	});
}

export type PathParams = {
	/** one string per finger (max 2): points `x,y` separated by spaces or `;` */
	paths: readonly string[];
	/** how long the gesture takes, in ms (default 600) */
	durationMs?: number;
	settleMs?: number;
};
export type PathResult = ActionResult & { fingers: number; paths: Point[][]; durationMs: number };

/** `warden ui gesture path --path 'x,y x,y' [--path …]`: raw touch paths, one finger each; fingers go down and lift together. */
export async function path(session: OpSession, params: PathParams): OpOutcome<PathResult> {
	const durationMs = params.durationMs ?? PATH_MS;
	const driver = await session.driver();
	if (!driver.success) return driver;
	const screen = await currentScreen(driver.data);
	if (!screen.success) return screen;
	const paths = parsePaths(params.paths, screen.data);
	if (!paths.success) return paths;
	const supported = requireCapability(driver.data, session.device.platform, "gesture path", "path", paths.data.length);
	if (!supported.success) return supported;
	const driven = fromDriver(
		await driver.data.gesture(
			paths.data.map((points) => ({ points })),
			{ durationMs }
		)
	);
	if (!driven.success) return driven;
	const fingers = paths.data.length;
	return finishAction(session, driver.data, params.settleMs, {
		action: "gesture-path",
		text: `${fingers}-finger path over ${durationMs} ms`,
		args: { paths: pathsText(paths.data), ms: durationMs },
		extra: { fingers, paths: paths.data, durationMs },
	});
}
