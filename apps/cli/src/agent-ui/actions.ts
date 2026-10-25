import type { Driver, KeyName, Point, Rect, ScreenInfo } from "@delacour/warden-e2e/driver/driver.types";
import { typeText } from "@delacour/warden-e2e/driver/typing";
import {
	contentPath,
	fieldValue,
	focusPoint,
	type SwipeDirection,
	screenRect,
	visibleRect,
} from "@delacour/warden-e2e/screen/actions";
import {
	type ClearMethod,
	confirmFieldValue,
	confirmReadsFor,
	focusClearType,
	hitTestField,
} from "@delacour/warden-e2e/screen/field";
import { entryOfElement, indexSnapshot, type NodeEntry } from "@delacour/warden-e2e/screen/nodes";
import { ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import {
	type ActionOptionValues,
	finishAction,
	parseSettle,
	pointAt,
	recordTarget,
	targetLabel,
	targetOf,
} from "./act";
import { driverUiError, fromDriver, type UiDeps } from "./driver";
import { type UiError, uiError } from "./output";
import { runUi } from "./run";
import { findInFresh, parseTarget, type ResolvedTarget } from "./target";

/** `fill` re-reads the field for up to this long before it counts as not taken (capped by `--timeout`). */
export const FILL_VERIFY_MS = 1000;
/** Pause between a scroll swipe and the next look at the screen. */
export const SCROLL_PAUSE_MS = 150;
/** `scroll --until` gives up after this many swipes unless `--max` says otherwise. */
export const DEFAULT_SCROLL_MAX = 10;
/** Fraction of the scroll region one swipe travels unless `[amount]` says otherwise. */
export const DEFAULT_SCROLL_AMOUNT = 0.5;
export const SWIPE_MS = 350;
/** A long press without an explicit duration. */
export const DEFAULT_LONGPRESS_MS = 800;

export type PressOptionValues = ActionOptionValues & { verify?: true };
export type FillOptionValues = ActionOptionValues & { secure?: true; verify: boolean };
export type TypeOptionValues = ActionOptionValues & { submit?: true };
export type SwipeOptionValues = ActionOptionValues & { from?: string };
export type ScrollOptionValues = ActionOptionValues & { until?: string; in?: string; max?: string };

const KEY_NAMES: readonly KeyName[] = [
	"Enter",
	"Backspace",
	"Tab",
	"Space",
	"Escape",
	"Delete",
	"Up",
	"Down",
	"Left",
	"Right",
];

/** `warden ui press|tap <target>`: tap an element or a point. `--verify` re-checks an `@eN` against a fresh snapshot first. */
export function uiPress(
	ctx: CommandContext,
	deps: UiDeps,
	words: string[],
	opts: PressOptionValues,
	action: "press" | "tap" = "press"
): Promise<number> {
	return runUi(ctx, deps, action, opts, async (device, env) => {
		const settle = parseSettle(opts.settle);
		if (!settle.success) return settle;
		const target = targetOf(words);
		if (!target.success) return target;
		const driver = await env.driver();
		if (!driver.success) return driver;
		const resolved = await pointAt(ctx, driver.data, device.udid, target.data, opts.verify === true);
		if (!resolved.success) return resolved;
		const tapped = fromDriver(await driver.data.tap(resolved.data.point));
		if (!tapped.success) return tapped;
		const where = recordTarget(target.data, resolved.data);
		return finishAction(ctx, deps, env, device, driver.data, settle.data, {
			action: "press",
			text: `pressed ${targetLabel(where)}`,
			target: where,
			...(resolved.data.verified === true || (opts.verify === true && target.data.kind === "selector")
				? { verified: true }
				: {}),
		});
	});
}

/** Split `<target words…> [ms]`: a trailing number is the duration unless the rest is just one number (then `x y` is a point). */
export function splitDuration(words: readonly string[]): { target: string[]; ms?: number } {
	const last = words[words.length - 1];
	if (last !== undefined && /^\d+$/.test(last) && words.length >= 2) {
		const rest = words.slice(0, -1);
		const lone = rest.length === 1 && /^-?\d+(?:\.\d+)?$/.test(rest[0] ?? "");
		if (!lone) return { target: rest, ms: Number(last) };
	}
	return { target: [...words] };
}

/** `warden ui gesture longpress <target> [ms]`. */
export function uiLongpress(
	ctx: CommandContext,
	deps: UiDeps,
	words: string[],
	opts: PressOptionValues
): Promise<number> {
	return runUi(ctx, deps, "gesture longpress", opts, async (device, env) => {
		const settle = parseSettle(opts.settle);
		if (!settle.success) return settle;
		const split = splitDuration(words);
		const durationMs = split.ms ?? DEFAULT_LONGPRESS_MS;
		const target = targetOf(split.target);
		if (!target.success) return target;
		const driver = await env.driver();
		if (!driver.success) return driver;
		const resolved = await pointAt(ctx, driver.data, device.udid, target.data, opts.verify === true);
		if (!resolved.success) return resolved;
		const pressed = fromDriver(await driver.data.longPress(resolved.data.point, { durationMs }));
		if (!pressed.success) return pressed;
		const where = recordTarget(target.data, resolved.data);
		return finishAction(ctx, deps, env, device, driver.data, settle.data, {
			action: "gesture-longpress",
			text: `long-pressed ${targetLabel(where)} for ${durationMs} ms`,
			target: where,
			args: { ms: durationMs },
			extra: { durationMs },
			...(resolved.data.verified === true || (opts.verify === true && target.data.kind === "selector")
				? { verified: true }
				: {}),
		});
	});
}

type FillRun = { ok: true } | { ok: false; held: string };

/** Where a tap puts the caret after the text: the field's right end, or the bare coordinate given. */
export function caretPoint(resolved: Pick<ResolvedTarget, "element" | "point">): Point {
	return resolved.element ? focusPoint(resolved.element.frame) : resolved.point;
}

/**
 * Polls the field until it holds `text` on consecutive reads (or the budget, extended while it changes, passes); a
 * field that cannot be found again reads as `(gone)`.
 */
async function readBack(
	ctx: CommandContext,
	deps: UiDeps,
	driver: Driver,
	wanted: NodeEntry,
	text: string,
	limits: { budgetMs: number; maxMs: number }
): Promise<Result<FillRun, UiError>> {
	const outcome = await confirmFieldValue<UiError>({
		text,
		now: ctx.now,
		sleep: deps.sleep,
		...limits,
		reads: confirmReadsFor(wanted, text),
		read: async () => {
			const read = await readField(driver, wanted);
			if (!read.success) return { ok: false, error: read.error };
			return {
				ok: true,
				reading: read.data === undefined ? { kind: "unreadable", note: "(gone)" } : { kind: "value", value: read.data },
			};
		},
	});
	if (outcome.status === "failed") return { success: false, error: outcome.error };
	return ok(outcome.status === "confirmed" ? { ok: true } : { ok: false, held: outcome.held });
}

/**
 * What the field shows now, or undefined when it cannot be found. First a hit-test at the field (≈10 ms; a full
 * snapshot takes 300-1000 ms and starves the app of the very key events being read back), then a snapshot.
 */
async function readField(driver: Driver, wanted: NodeEntry): Promise<Result<string | undefined, UiError>> {
	const hit = await hitTestField(driver, wanted);
	if (hit.ok && hit.entry) return ok(fieldValue(hit.entry));
	const fresh = await driver.snapshot();
	if (!fresh.success) return { success: false, error: driverUiError(fresh.error) };
	const found = findInFresh(wanted, indexSnapshot(fresh.data));
	return ok(found ? fieldValue(found) : undefined);
}

type FillPlan = {
	/** the field as last seen; undefined (`x y` target) = nothing to clear or read back */
	entry: NodeEntry | undefined;
	text: string;
	/** password field: types but never reads back */
	secure: boolean;
	verify: boolean;
	budgetMs: number;
	maxMs: number;
};

/**
 * Focus, empty and type; with `verify` read the field back and retry once, backspacing one key per character that
 * time (the first attempt selects all where the driver can). Resolves to what `fill` reports as `verified`.
 */
async function typeAndConfirm(
	ctx: CommandContext,
	deps: UiDeps,
	driver: Driver,
	resolved: ResolvedTarget,
	plan: FillPlan
): Promise<Result<boolean | "unconfirmed" | undefined, UiError>> {
	const { entry, text } = plan;
	const readable = plan.verify && !plan.secure && entry !== undefined;
	for (let attempt = 1; attempt <= (readable ? 2 : 1); attempt += 1) {
		const method: ClearMethod = attempt === 1 ? "auto" : "counted";
		const typed = fromDriver(
			await focusClearType(driver, deps.sleep, caretPoint(resolved), entry, text, method, ctx.env)
		);
		if (!typed.success) return typed;
		if (!readable) break;
		const back = await readBack(ctx, deps, driver, entry, text, { budgetMs: plan.budgetMs, maxMs: plan.maxMs });
		if (!back.success) return back;
		if (back.data.ok) return ok(true);
		if (attempt === 2) {
			return {
				success: false,
				error: uiError(
					"failed",
					`fill did not take: expected ${JSON.stringify(text)} but the field holds ${JSON.stringify(back.data.held)}`,
					{ details: { expected: text, held: back.data.held } }
				),
			};
		}
	}
	return ok(plan.verify ? "unconfirmed" : undefined);
}

/**
 * `warden ui fill <target> <text>`: focus the field, empty it, type, then read it back (retrying once).
 * `--secure` (and fields the OS marks secure) cannot be read back: reported as `unconfirmed`, and the
 * text is neither echoed nor recorded. `--no-verify` skips the read-back.
 */
export function uiFill(ctx: CommandContext, deps: UiDeps, words: string[], opts: FillOptionValues): Promise<number> {
	return runUi(ctx, deps, "fill", opts, async (device, env) => {
		const settle = parseSettle(opts.settle);
		if (!settle.success) return settle;
		const text = words[words.length - 1];
		if (words.length < 2 || text === undefined) {
			return {
				success: false,
				error: uiError("usage", "fill needs a target and the text", { hint: "warden ui fill <target> <text>" }),
			};
		}
		const target = targetOf(words.slice(0, -1));
		if (!target.success) return target;
		const driver = await env.driver();
		if (!driver.success) return driver;
		const resolved = await pointAt(ctx, driver.data, device.udid, target.data, false);
		if (!resolved.success) return resolved;
		const entry = resolved.data.element
			? entryOfElement(resolved.data.element, { platform: device.platform })
			: undefined;
		const secure = opts.secure === true || entry?.secure === true;

		const filled = await typeAndConfirm(ctx, deps, driver.data, resolved.data, {
			entry,
			secure,
			text,
			verify: opts.verify,
			budgetMs: Math.min(FILL_VERIFY_MS, env.timeoutMs),
			maxMs: env.timeoutMs,
		});
		if (!filled.success) return filled;
		const verified = filled.data;
		const where = recordTarget(target.data, resolved.data);
		const shown = secure ? `${[...text].length} characters (secure)` : JSON.stringify(text);
		return finishAction(ctx, deps, env, device, driver.data, settle.data, {
			action: "fill",
			text: `filled ${targetLabel(where)} with ${shown}${verified === "unconfirmed" ? " (unconfirmed)" : ""}`,
			target: where,
			...(verified !== undefined ? { verified } : {}),
			args: secure ? { secure: true } : { text },
			...(secure ? { secret: text } : {}),
			extra: { characters: [...text].length, ...(secure ? { secure: true } : {}) },
		});
	});
}

/** `warden ui type <text> [--submit]`: type into whatever has focus; `--submit` then presses Enter. */
export function uiType(ctx: CommandContext, deps: UiDeps, text: string, opts: TypeOptionValues): Promise<number> {
	return runUi(ctx, deps, "type", opts, async (device, env) => {
		const settle = parseSettle(opts.settle);
		if (!settle.success) return settle;
		const driver = await env.driver();
		if (!driver.success) return driver;
		const typed = fromDriver(await typeText(driver.data, deps.sleep, text));
		if (!typed.success) return typed;
		if (opts.submit === true) {
			const submitted = fromDriver(await driver.data.key("Enter"));
			if (!submitted.success) return submitted;
		}
		return finishAction(ctx, deps, env, device, driver.data, settle.data, {
			action: "type",
			text: `typed ${JSON.stringify(text)}${opts.submit === true ? " and pressed Enter" : ""}`,
			args: { text, ...(opts.submit === true ? { submit: true } : {}) },
			extra: { characters: [...text].length, submitted: opts.submit === true },
		});
	});
}

/** `Enter`, `enter`, `ENTER` → `Enter`. */
export function parseKey(raw: string): Result<KeyName, UiError> {
	const found = KEY_NAMES.find((name) => name.toLowerCase() === raw.toLowerCase());
	if (found) return ok(found);
	return {
		success: false,
		error: uiError("usage", `unknown key "${raw}"`, { hint: `one of ${KEY_NAMES.join(", ")}` }),
	};
}

/** `warden ui key <name>`. */
export function uiKey(ctx: CommandContext, deps: UiDeps, name: string, opts: ActionOptionValues): Promise<number> {
	return runUi(ctx, deps, "key", opts, async (device, env) => {
		const settle = parseSettle(opts.settle);
		if (!settle.success) return settle;
		const key = parseKey(name);
		if (!key.success) return key;
		const driver = await env.driver();
		if (!driver.success) return driver;
		const pressed = fromDriver(await driver.data.key(key.data));
		if (!pressed.success) return pressed;
		return finishAction(ctx, deps, env, device, driver.data, settle.data, {
			action: "key",
			text: `pressed ${key.data}`,
			args: { key: key.data },
			extra: { key: key.data },
		});
	});
}

/** A direction word; `scroll` and the recorded steps read it as the content's direction, `swipe` as the finger's. */
export type Way = SwipeDirection;
export const WAYS: readonly Way[] = ["up", "down", "left", "right"];

export function isWay(word: string | undefined): word is Way {
	return WAYS.some((way) => way === word);
}

export const OPPOSITE: Record<Way, Way> = { up: "down", down: "up", left: "right", right: "left" };

/**
 * The finger path inside `rect` that moves `distance` (0-1 of the rect) the way the finger travels (`up` = the finger
 * moves up, revealing what is below). The CLI's `swipe <dir>` convention: the shared geometry (`contentPath`) takes the
 * content's direction, which is the opposite.
 */
export function fingerPath(way: Way, rect: Rect, distance: number): { from: Point; to: Point } {
	return contentPath(OPPOSITE[way], rect, distance);
}

export async function currentScreen(driver: Driver): Promise<Result<ScreenInfo, UiError>> {
	const taken = await driver.snapshot({ interactiveOnly: true });
	return taken.success ? ok(taken.data.screen) : { success: false, error: driverUiError(taken.error) };
}

/** The part of the screen a swipe or scroll works in: a target's visible frame, else the whole screen. */
export async function regionOf(
	ctx: CommandContext,
	driver: Driver,
	udid: string,
	from: string | undefined
): Promise<Result<{ rect: Rect; screen: ScreenInfo }, UiError>> {
	const screen = await currentScreen(driver);
	if (!screen.success) return screen;
	if (from === undefined) return ok({ rect: screenRect(screen.data), screen: screen.data });
	const target = parseTarget(from);
	if (!target.success) return target;
	const resolved = await pointAt(ctx, driver, udid, target.data, false);
	if (!resolved.success) return resolved;
	if (!resolved.data.element) {
		return { success: false, error: uiError("usage", "a region must be an element (@eN or a selector), not a point") };
	}
	return ok({ rect: visibleRect(resolved.data.element.frame, screen.data), screen: screen.data });
}

/**
 * `warden ui gesture swipe <up|down|left|right | x1 y1 x2 y2> [--from <target>]`: a raw finger swipe. The word is the way
 * the finger moves (`swipe up` moves content up, revealing what is below); `--from` swipes inside that element.
 */
export function uiSwipe(ctx: CommandContext, deps: UiDeps, words: string[], opts: SwipeOptionValues): Promise<number> {
	return runUi(ctx, deps, "gesture swipe", opts, async (device, env) => {
		const settle = parseSettle(opts.settle);
		if (!settle.success) return settle;
		const driver = await env.driver();
		if (!driver.success) return driver;
		let from: Point;
		let to: Point;
		let label: string;
		if (words.length === 1 && isWay(words[0])) {
			const region = await regionOf(ctx, driver.data, device.udid, opts.from);
			if (!region.success) return region;
			({ from, to } = fingerPath(words[0], region.data.rect, DEFAULT_SCROLL_AMOUNT));
			label = words[0];
		} else if (words.length === 4 && words.every((word) => /^-?\d+(?:\.\d+)?$/.test(word))) {
			const [x1, y1, x2, y2] = words.map(Number);
			from = { x: x1 ?? 0, y: y1 ?? 0 };
			to = { x: x2 ?? 0, y: y2 ?? 0 };
			label = `(${x1},${y1}) to (${x2},${y2})`;
		} else {
			return {
				success: false,
				error: uiError("usage", "swipe needs a direction or four coordinates", {
					hint: "warden ui gesture swipe <up|down|left|right> | warden ui gesture swipe x1 y1 x2 y2",
				}),
			};
		}
		const swiped = fromDriver(await driver.data.swipe(from, to, { durationMs: SWIPE_MS, momentum: false }));
		if (!swiped.success) return swiped;
		return finishAction(ctx, deps, env, device, driver.data, settle.data, {
			action: "gesture-swipe",
			text: `swiped ${label}`,
			args: { from: `${from.x},${from.y}`, to: `${to.x},${to.y}` },
			extra: { from, to },
		});
	});
}

export function parseAmount(raw: string | undefined): Result<number, UiError> {
	if (raw === undefined) return ok(DEFAULT_SCROLL_AMOUNT);
	const amount = Number(raw);
	if (!Number.isFinite(amount) || amount <= 0 || amount > 1) {
		return {
			success: false,
			error: uiError("usage", `amount must be above 0 and at most 1 (a share of the region), got "${raw}"`),
		};
	}
	return ok(amount);
}
