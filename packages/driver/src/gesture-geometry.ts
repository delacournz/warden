import type { Result } from "@delacour/warden-types/result";
import type { DriverError, GestureOptions, Point, TouchPath, TwoFingerOptions } from "./driver.types";
import { driverError } from "./errors";

/**
 * Touch-path geometry shared by both drivers: `gesture`, `pinch` and `rotate` all become a `GesturePlan`, one
 * frame per ~16 ms on a shared timeline, which `warden-simd` (`gesture` op) and `warden-uiad` (`gesture` op)
 * only replay. Fingers go down together on the first frame and lift together after the last one (the iOS
 * transports carry one phase for both contacts), so every path has the same frame count.
 */

export const GESTURE_FRAME_MS = 16;
export const GESTURE_MAX_FRAMES = 1000;
export const GESTURE_MAX_MS = 60_000;
export const GESTURE_MAX_POINTERS = 2;
export const DEFAULT_GESTURE_MS = 300;
export const DEFAULT_PINCH_MS = 400;
export const DEFAULT_ROTATE_MS = 500;
/** finger distance from the centre: points on iOS; Android multiplies by the screen scale */
export const DEFAULT_RADIUS = 100;
/** two-finger gestures rest at their end before lifting, so recognisers read ~0 velocity */
export const TWO_FINGER_RELEASE_MS = 50;
/** one sample per this many degrees of a rotation, so the fingers follow the arc, not its chord */
const ARC_STEP_DEGREES = 5;

/** What the native servers replay: frame `k` of every path is `holdMs + k * frameMs` after touch-down. */
export type GesturePlan = {
	paths: Point[][];
	frameMs: number;
	holdMs: number;
	releaseMs: number;
	totalMs: number;
};

export type TwoFingerSpec = { radius: number; angle?: number; scale?: number; degrees?: number };

type Timed = { x: number; y: number; t: number };

function bad(message: string): { success: false; error: DriverError } {
	return { success: false, error: driverError("E_BAD_REQUEST", message) };
}

function finite(value: number): boolean {
	return Number.isFinite(value);
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

function nonNegative(name: string, value: number | undefined): string | undefined {
	if (value === undefined) return undefined;
	return finite(value) && value >= 0 ? undefined : `${name} must be a finite number >= 0`;
}

/** Times an untimed path by arc length over `durationMs`; a path with no length spreads evenly by index. */
function timeByLength(points: readonly Point[], durationMs: number): Timed[] {
	if (points.length === 1) return points.map((p) => ({ x: p.x, y: p.y, t: 0 }));
	const lengths = [0];
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1] as Point;
		const b = points[i] as Point;
		lengths.push((lengths[i - 1] as number) + Math.hypot(b.x - a.x, b.y - a.y));
	}
	const total = lengths.at(-1) as number;
	return points.map((p, i) => ({
		x: p.x,
		y: p.y,
		t: total > 0 ? ((lengths[i] as number) / total) * durationMs : (i / (points.length - 1)) * durationMs,
	}));
}

/** The finger's position at `at` ms: linear between its timed points, held at the last one after it. */
function positionAt(path: readonly Timed[], at: number): Point {
	let i = 0;
	while (i < path.length - 1 && (path[i + 1] as Timed).t <= at) i++;
	const from = path[i] as Timed;
	const to = path[i + 1];
	if (!to) return { x: from.x, y: from.y };
	const f = (at - from.t) / (to.t - from.t);
	return { x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f };
}

type Timing = { durationMs: number; holdMs: number; releaseMs: number; timed: boolean };

/** The options, judged once the paths are known to be timed or not; a string is the `E_BAD_REQUEST` message. */
function checkOptions(opts: GestureOptions | undefined, timed: boolean): Timing | string {
	if (timed && opts?.durationMs !== undefined) return "`durationMs` is for untimed paths; these carry `t`";
	const durationMs = opts?.durationMs ?? DEFAULT_GESTURE_MS;
	if (!finite(durationMs) || durationMs <= 0) return "durationMs must be a finite number > 0";
	const problem = nonNegative("holdMs", opts?.holdMs) ?? nonNegative("releaseMs", opts?.releaseMs);
	if (problem) return problem;
	return { durationMs, holdMs: opts?.holdMs ?? 0, releaseMs: opts?.releaseMs ?? 0, timed };
}

/** Everything about the input that can be judged before timing it; a string is the `E_BAD_REQUEST` message. */
function checkInput(
	paths: readonly TouchPath[],
	opts: GestureOptions | undefined,
	maxPointers: 0 | 1 | 2
): Timing | string | DriverError {
	if (paths.length < 1 || paths.length > GESTURE_MAX_POINTERS) {
		return `a gesture takes 1 to ${GESTURE_MAX_POINTERS} finger paths, got ${paths.length}`;
	}
	if (paths.length > maxPointers) {
		return driverError("E_UNSUPPORTED", `this driver takes at most ${maxPointers} finger(s), got ${paths.length}`);
	}
	const points = paths.flatMap((path) => path.points);
	if (paths.some((path) => path.points.length === 0)) return "every finger path needs at least one point";
	if (points.some((p) => !finite(p.x) || !finite(p.y))) return "gesture points must be finite";
	const timed = points.filter((p) => p.t !== undefined).length;
	if (timed !== 0 && timed !== points.length) return "give `t` on every point of a gesture or on none";
	return checkOptions(opts, timed > 0);
}

/** A timed path as given, checked: it starts at touch-down and its `t` never goes back. */
function timedFinger(path: TouchPath): Timed[] | string {
	const finger = path.points.map((p) => ({ x: p.x, y: p.y, t: p.t as number }));
	if (finger[0]?.t !== 0) return "a timed path starts at t = 0 (touch-down)";
	if (finger.some((p, i) => !finite(p.t) || (i > 0 && p.t < (finger[i - 1] as Timed).t))) {
		return "`t` must be finite and must not decrease along a path";
	}
	return finger;
}

/**
 * Validates 1–2 finger paths and resamples them onto one timeline. Bad input is `E_BAD_REQUEST`; more fingers
 * than the driver takes is `E_UNSUPPORTED`.
 */
export function planGesture(
	paths: readonly TouchPath[],
	opts: GestureOptions | undefined,
	maxPointers: 0 | 1 | 2
): Result<GesturePlan, DriverError> {
	const timing = checkInput(paths, opts, maxPointers);
	if (typeof timing === "string") return bad(timing);
	if ("code" in timing) return { success: false, error: timing };
	const { durationMs, holdMs, releaseMs } = timing;
	const fingers: Timed[][] = [];
	for (const path of paths) {
		const finger = timing.timed ? timedFinger(path) : timeByLength(path.points, durationMs);
		if (typeof finger === "string") return bad(finger);
		fingers.push(finger);
	}
	const span = Math.max(...fingers.map((finger) => (finger.at(-1) as Timed).t));
	if (span + holdMs + releaseMs > GESTURE_MAX_MS) return bad(`a gesture lasts at most ${GESTURE_MAX_MS} ms`);
	const intervals = span === 0 ? 0 : Math.min(GESTURE_MAX_FRAMES, Math.ceil(span / GESTURE_FRAME_MS));
	const frameMs = intervals === 0 ? GESTURE_FRAME_MS : span / intervals;
	const frames = fingers.map((finger) =>
		Array.from({ length: intervals + 1 }, (_, k) => {
			const p = positionAt(finger, k === intervals ? span : k * frameMs);
			return { x: round(p.x), y: round(p.y) };
		})
	);
	return { success: true, data: { paths: frames, frameMs, holdMs, releaseMs, totalMs: span + holdMs + releaseMs } };
}

/**
 * Two fingers `radius` either side of `center` on an axis at `angle` degrees (0 = horizontal; finger 1 on the
 * negative side), spreading to `radius * scale` and turning `degrees` clockwise (screen space, y down) over
 * `durationMs`. A turn is sampled every few degrees so the fingers follow the arc.
 */
export function twoFingerPaths(center: Point, spec: TwoFingerSpec, durationMs: number): [TouchPath, TouchPath] {
	const scale = spec.scale ?? 1;
	const degrees = spec.degrees ?? 0;
	const steps = degrees === 0 ? 1 : Math.max(1, Math.ceil(Math.abs(degrees) / ARC_STEP_DEGREES));
	const a: (Point & { t: number })[] = [];
	const b: (Point & { t: number })[] = [];
	for (let i = 0; i <= steps; i++) {
		const u = i / steps;
		const theta = (((spec.angle ?? 0) + degrees * u) * Math.PI) / 180;
		const r = spec.radius * (1 + (scale - 1) * u);
		const dx = r * Math.cos(theta);
		const dy = r * Math.sin(theta);
		const t = u * durationMs;
		a.push({ x: center.x - dx, y: center.y - dy, t });
		b.push({ x: center.x + dx, y: center.y + dy, t });
	}
	return [{ points: a }, { points: b }];
}

function twoFinger(
	center: Point,
	spec: { scale?: number; degrees?: number },
	opts: TwoFingerOptions | undefined,
	defaultRadius: number,
	defaultMs: number
): Result<GesturePlan, DriverError> {
	if (!finite(center.x) || !finite(center.y)) return bad("the centre must be finite");
	const radius = opts?.radius ?? defaultRadius;
	if (!finite(radius) || radius <= 0) return bad("radius must be a finite number > 0");
	if (opts?.angle !== undefined && !finite(opts.angle)) return bad("angle must be finite");
	const durationMs = opts?.durationMs ?? defaultMs;
	if (!finite(durationMs) || durationMs <= 0) return bad("durationMs must be a finite number > 0");
	const paths = twoFingerPaths(
		center,
		{ radius, ...spec, ...(opts?.angle !== undefined ? { angle: opts.angle } : {}) },
		durationMs
	);
	return planGesture(paths, { releaseMs: TWO_FINGER_RELEASE_MS }, 2);
}

/** Two fingers spreading (`scale` > 1) or closing (< 1) around `center`. */
export function pinchPlan(
	center: Point,
	scale: number,
	opts: TwoFingerOptions | undefined,
	defaultRadius: number
): Result<GesturePlan, DriverError> {
	if (!finite(scale) || scale <= 0) return bad("scale must be a finite number > 0");
	return twoFinger(center, { scale }, opts, defaultRadius, DEFAULT_PINCH_MS);
}

/** Two fingers turning `degrees` around `center`; positive is clockwise on screen. */
export function rotatePlan(
	center: Point,
	degrees: number,
	opts: TwoFingerOptions | undefined,
	defaultRadius: number
): Result<GesturePlan, DriverError> {
	if (!finite(degrees)) return bad("degrees must be finite");
	return twoFinger(center, { degrees }, opts, defaultRadius, DEFAULT_ROTATE_MS);
}
