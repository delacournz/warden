import type { Driver, Point, Rect, ScreenInfo } from "@delacour/warden-e2e/driver/driver.types";
import {
	MAX_ROTATE_DEGREES,
	PATH_MS,
	PINCH_MS,
	pinchRadius,
	ROTATE_MS,
	rotateRadius,
	SCALE_RANGE,
	screenRect,
	visibleRect,
} from "@delacour/warden-e2e/screen/actions";
import { ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import {
	type ActionDone,
	type ActionOptionValues,
	finishAction,
	parseSettle,
	pointAt,
	recordTarget,
	targetLabel,
	targetOf,
} from "./act";
import { currentScreen } from "./actions";
import type { UiDevice } from "./device";
import { fromDriver, type UiDeps } from "./driver";
import { type UiError, type UiSuccess, uiError } from "./output";
import type { RecordTarget } from "./record";
import { runUi, type UiRunEnv } from "./run";
import { positiveInt } from "./snapshot-command";

const MAX_PATHS = 2;

export type PinchOptionValues = ActionOptionValues & { duration?: string; radius?: string; verify?: true };
export type GesturePathOptionValues = ActionOptionValues & { path: string[]; duration?: string };

const NUMBER = /^-?\d+(?:\.\d+)?$/;
const POINT = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/;

type AmountKind = "scale" | "degrees";

const AMOUNT_SYNTAX: Record<AmountKind, string> = {
	scale: "warden ui gesture pinch [@eN|selector|x y] <scale>",
	degrees: "warden ui gesture rotate [@eN|selector|x y] <degrees>",
};

function amountUsage(message: string, kind: AmountKind): { success: false; error: UiError } {
	return { success: false, error: uiError("usage", message, { hint: AMOUNT_SYNTAX[kind] }) };
}

/** Why `amount` is out of range for `kind`, or `undefined` when it is fine. */
function amountProblem(kind: AmountKind, amount: number, raw: string): string | undefined {
	if (kind === "scale") {
		const outOfRange = !Number.isFinite(amount) || amount < SCALE_RANGE[0] || amount > SCALE_RANGE[1] || amount === 1;
		return outOfRange
			? `the scale must be between ${SCALE_RANGE[0]} and ${SCALE_RANGE[1]} and not 1, got "${raw}"`
			: undefined;
	}
	const outOfRange = !Number.isFinite(amount) || amount === 0 || Math.abs(amount) > MAX_ROTATE_DEGREES;
	return outOfRange
		? `the degrees must be non-zero and at most ${MAX_ROTATE_DEGREES} either way, got "${raw}"`
		: undefined;
}

/**
 * Split `<target words…> <amount>`: the last word is the scale or the degrees, the rest is the target (`@eN`, a selector
 * or `x y`); no target words means the screen centre. A rest of only numbers must be exactly an `x y` pair.
 */
export function splitAmount(
	words: readonly string[],
	kind: AmountKind
): Result<{ target: string[]; amount: number }, UiError> {
	const last = words[words.length - 1];
	if (last === undefined) return amountUsage(`${kind === "scale" ? "pinch" : "rotate"} needs a ${kind}`, kind);
	if (!NUMBER.test(last)) return amountUsage(`the ${kind} must be a number, got "${last}"`, kind);
	const amount = Number(last);
	const problem = amountProblem(kind, amount, last);
	if (problem !== undefined) return amountUsage(problem, kind);
	const target = words.slice(0, -1);
	if (target.length > 0 && target.every((word) => NUMBER.test(word)) && target.length !== 2) {
		return amountUsage(`a point target needs both coordinates (x y), got "${target.join(" ")}"`, kind);
	}
	return ok({ target, amount });
}

/** One `--path` per finger, points `x,y` separated by spaces or `;`: 1-2 paths of at least 2 points, all on the screen. */
export function parsePaths(raw: readonly string[], screen: ScreenInfo): Result<Point[][], UiError> {
	const hint = "warden ui gesture path --path 'x,y x,y …' [--path 'x,y x,y …']";
	const bad = (message: string) => ({ success: false as const, error: uiError("usage", message, { hint }) });
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
	return ok(paths);
}

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
	ctx: CommandContext,
	driver: Driver,
	udid: string,
	words: readonly string[],
	verify: boolean
): Promise<Result<GestureRegion, UiError>> {
	const screen = await currentScreen(driver);
	if (!screen.success) return screen;
	const whole = screenRect(screen.data);
	if (words.length === 0) {
		return ok({ rect: whole, screen: screen.data, center: { x: whole.width / 2, y: whole.height / 2 } });
	}
	const target = targetOf(words);
	if (!target.success) return target;
	const resolved = await pointAt(ctx, driver, udid, target.data, verify);
	if (!resolved.success) return resolved;
	const where = recordTarget(target.data, resolved.data);
	if (!resolved.data.element) {
		return ok({ rect: whole, screen: screen.data, center: resolved.data.point, target: where });
	}
	const rect = visibleRect(resolved.data.element.frame, screen.data);
	return ok({
		rect,
		screen: screen.data,
		center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
		target: where,
	});
}

/** Fail (exit 1, `details.driver: E_UNSUPPORTED`) when the driver cannot do `verb`: no two-finger support, or fewer pointers than fingers. */
export function requireCapability(
	driver: Driver,
	platform: UiDevice["platform"],
	verb: string,
	key: "pinch" | "path",
	fingers = 2
): Result<void, UiError> {
	const { capabilities } = driver;
	if ((key === "path" || capabilities.pinch) && fingers <= capabilities.maxPointers) return ok(undefined);
	return {
		success: false,
		error: uiError("failed", `${verb} is not supported on ${platform} here`, {
			hint: "Android needs warden-uiad (Android 8+, WARDEN_ANDROID_UIAD unset)",
			details: { driver: "E_UNSUPPORTED", capability: key },
		}),
	};
}

function parseTwoFinger(
	opts: PinchOptionValues,
	fallbackMs: number
): Result<{ durationMs: number; radius?: number }, UiError> {
	const duration = opts.duration === undefined ? ok(fallbackMs) : positiveInt("--duration", opts.duration);
	if (!duration.success) return duration;
	if (opts.radius === undefined) return ok({ durationMs: duration.data });
	const radius = Number(opts.radius);
	if (!NUMBER.test(opts.radius) || !(radius > 0)) {
		return { success: false, error: uiError("usage", `--radius must be a positive number, got "${opts.radius}"`) };
	}
	return ok({ durationMs: duration.data, radius });
}

type TwoFingerKind = "pinch" | "rotate";

/** Per-kind constants of the two-finger gestures: the amount's name, default duration and recorded action. */
const TWO_FINGER = {
	pinch: { key: "scale", defaultMs: PINCH_MS, action: "gesture-pinch" },
	rotate: { key: "degrees", defaultMs: ROTATE_MS, action: "gesture-rotate" },
} as const satisfies Record<TwoFingerKind, { key: AmountKind; defaultMs: number; action: string }>;

/** The finger circle's radius: `--radius` when given, else sized from the region. */
function twoFingerRadius(
	kind: TwoFingerKind,
	region: GestureRegion,
	amount: number,
	explicit: number | undefined
): number {
	if (explicit !== undefined) return explicit;
	return kind === "pinch" ? pinchRadius(region.rect, amount, region.screen) : rotateRadius(region.rect, region.screen);
}

/** Send the pinch or rotate to the driver. */
async function driveTwoFinger(
	driver: Driver,
	kind: TwoFingerKind,
	center: Point,
	amount: number,
	options: { durationMs: number; radius: number }
): Promise<Result<void, UiError>> {
	return fromDriver(
		kind === "pinch" ? await driver.pinch(center, amount, options) : await driver.rotate(center, amount, options)
	);
}

type TwoFingerReport = {
	kind: TwoFingerKind;
	region: GestureRegion;
	amount: number;
	durationMs: number;
	radius: number;
	explicitRadius: number | undefined;
	verify: boolean;
};

/** What a finished pinch or rotate reports and records. */
function twoFingerDone(report: TwoFingerReport): ActionDone {
	const { kind, region, amount, durationMs, radius, explicitRadius, verify } = report;
	const { center, target } = region;
	const { key, action } = TWO_FINGER[kind];
	const around = target ? targetLabel(target) : `(${Math.round(center.x)},${Math.round(center.y)})`;
	return {
		action,
		text: kind === "pinch" ? `pinched ${around} by ${amount}` : `rotated ${around} by ${amount} degrees`,
		...(target ? { target } : {}),
		...(verify && target?.ref !== undefined ? { verified: true } : {}),
		args: { [key]: amount, ms: durationMs, ...(explicitRadius !== undefined ? { radius: explicitRadius } : {}) },
		extra: { [key]: amount, center, radius: Math.round(radius * 100) / 100, durationMs },
	};
}

/** One pinch or rotate on a claimed device: parse, region, capability, drive, finish. */
async function runTwoFingerAction(
	ctx: CommandContext,
	deps: UiDeps,
	kind: TwoFingerKind,
	words: string[],
	opts: PinchOptionValues,
	device: UiDevice,
	env: UiRunEnv
): Promise<Result<UiSuccess, UiError>> {
	const settle = parseSettle(opts.settle);
	if (!settle.success) return settle;
	const split = splitAmount(words, TWO_FINGER[kind].key);
	if (!split.success) return split;
	const parsed = parseTwoFinger(opts, TWO_FINGER[kind].defaultMs);
	if (!parsed.success) return parsed;
	const driver = await env.driver();
	if (!driver.success) return driver;
	const verify = opts.verify === true;
	const region = await gestureRegion(ctx, driver.data, device.udid, split.data.target, verify);
	if (!region.success) return region;
	const supported = requireCapability(driver.data, device.platform, kind, "pinch");
	if (!supported.success) return supported;
	const { amount } = split.data;
	const { durationMs } = parsed.data;
	const radius = twoFingerRadius(kind, region.data, amount, parsed.data.radius);
	const driven = await driveTwoFinger(driver.data, kind, region.data.center, amount, { durationMs, radius });
	if (!driven.success) return driven;
	const done = twoFingerDone({
		kind,
		region: region.data,
		amount,
		durationMs,
		radius,
		explicitRadius: parsed.data.radius,
		verify,
	});
	return finishAction(ctx, deps, env, device, driver.data, settle.data, done);
}

/** Shared body of `gesture pinch` and `gesture rotate`: parse, region, capability, drive, finish. */
function runTwoFinger(
	ctx: CommandContext,
	deps: UiDeps,
	kind: TwoFingerKind,
	words: string[],
	opts: PinchOptionValues
): Promise<number> {
	return runUi(ctx, deps, `gesture ${kind}`, opts, (device, env) =>
		runTwoFingerAction(ctx, deps, kind, words, opts, device, env)
	);
}

/** `warden ui gesture pinch [target] <scale>`: two fingers around the target (or the screen centre) spread or close. */
export function uiGesturePinch(
	ctx: CommandContext,
	deps: UiDeps,
	words: string[],
	opts: PinchOptionValues
): Promise<number> {
	return runTwoFinger(ctx, deps, "pinch", words, opts);
}

/** `warden ui gesture rotate [target] <degrees>`: two fingers turn around the target (or the screen centre). */
export function uiGestureRotate(
	ctx: CommandContext,
	deps: UiDeps,
	words: string[],
	opts: PinchOptionValues
): Promise<number> {
	return runTwoFinger(ctx, deps, "rotate", words, opts);
}

/** `warden ui gesture path --path 'x,y x,y' [--path …]`: raw touch paths, one finger each; fingers go down and lift together. */
export function uiGesturePath(ctx: CommandContext, deps: UiDeps, opts: GesturePathOptionValues): Promise<number> {
	return runUi(ctx, deps, "gesture path", opts, (device, env) => runGesturePath(ctx, deps, opts, device, env));
}

/** One `gesture path` on a claimed device: parse, check the driver, drive, finish. */
async function runGesturePath(
	ctx: CommandContext,
	deps: UiDeps,
	opts: GesturePathOptionValues,
	device: UiDevice,
	env: UiRunEnv
): Promise<Result<UiSuccess, UiError>> {
	const settle = parseSettle(opts.settle);
	if (!settle.success) return settle;
	const duration = opts.duration === undefined ? ok(PATH_MS) : positiveInt("--duration", opts.duration);
	if (!duration.success) return duration;
	const driver = await env.driver();
	if (!driver.success) return driver;
	const screen = await currentScreen(driver.data);
	if (!screen.success) return screen;
	const paths = parsePaths(opts.path, screen.data);
	if (!paths.success) return paths;
	const supported = requireCapability(driver.data, device.platform, "gesture path", "path", paths.data.length);
	if (!supported.success) return supported;
	const driven = fromDriver(
		await driver.data.gesture(
			paths.data.map((points) => ({ points })),
			{ durationMs: duration.data }
		)
	);
	if (!driven.success) return driven;
	const fingers = paths.data.length;
	return finishAction(ctx, deps, env, device, driver.data, settle.data, {
		action: "gesture-path",
		text: `${fingers}-finger path over ${duration.data} ms`,
		args: { paths: pathsText(paths.data), ms: duration.data },
		extra: { fingers, paths: paths.data, durationMs: duration.data },
	});
}
