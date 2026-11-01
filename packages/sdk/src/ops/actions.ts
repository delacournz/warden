import type { Driver, KeyName, Point, Rect, ScreenInfo } from "@delacour/warden-driver/driver.types";
import { typeText } from "@delacour/warden-driver/typing";
import {
	contentPath,
	fieldValue,
	focusPoint,
	type SwipeDirection,
	screenRect,
	visibleRect,
} from "@delacour/warden-screen/actions";
import {
	type ClearMethod,
	confirmFieldValue,
	confirmReadsFor,
	type FillVia,
	focusClearType,
	hitTestField,
	setTextOptedIn,
} from "@delacour/warden-screen/field";
import { entryOfElement, indexSnapshot, type NodeEntry } from "@delacour/warden-screen/nodes";
import type { WardenError } from "@delacour/warden-types/error";
import { ok, type Result } from "@delacour/warden-types/result";
import { type ActionResult, finishAction, pointAt, recordTarget, targetLabel, targetOf } from "./act";
import { driverError, fail, fromDriver, opError } from "./errors";
import type { OpOutcome, OpSession } from "./session";
import { findInFresh, parseTarget, type ResolvedTarget } from "./target";

/** `fill` re-reads the field for up to this long before it counts as not taken (capped by the session timeout). */
export const FILL_VERIFY_MS = 1000;
/** Pause between a scroll swipe and the next look at the screen. */
export const SCROLL_PAUSE_MS = 150;
/** `scroll --until` gives up after this many swipes unless told otherwise. */
export const DEFAULT_SCROLL_MAX = 10;
/** Fraction of the scroll region one swipe travels unless told otherwise. */
export const DEFAULT_SCROLL_AMOUNT = 0.5;
export const SWIPE_MS = 350;
/** A long press without an explicit duration. */
export const DEFAULT_LONGPRESS_MS = 800;

export const KEY_NAMES: readonly KeyName[] = [
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

/** `Enter`, `enter`, `ENTER` → `Enter`. */
export function parseKey(raw: string): Result<KeyName, WardenError> {
	const found = KEY_NAMES.find((name) => name.toLowerCase() === raw.toLowerCase());
	if (found) return ok(found);
	return fail(opError("usage", `unknown key "${raw}"`, { hint: `one of ${KEY_NAMES.join(", ")}` }));
}

/** A direction word; `scroll` and the flow steps read it as the content's direction, `swipe` as the finger's. */
export type Way = SwipeDirection;
export const WAYS: readonly Way[] = ["up", "down", "left", "right"];

export function isWay(word: string | undefined): word is Way {
	return WAYS.some((way) => way === word);
}

export const OPPOSITE: Record<Way, Way> = { up: "down", down: "up", left: "right", right: "left" };

/**
 * The finger path inside `rect` that moves `distance` (0-1 of the rect) the way the finger travels (`up` = the finger
 * moves up, revealing what is below). The shared geometry (`contentPath`) takes the content's direction, which is the
 * opposite.
 */
export function fingerPath(way: Way, rect: Rect, distance: number): { from: Point; to: Point } {
	return contentPath(OPPOSITE[way], rect, distance);
}

export async function currentScreen(driver: Driver): Promise<Result<ScreenInfo, WardenError>> {
	const taken = await driver.snapshot({ interactiveOnly: true });
	return taken.success ? ok(taken.data.screen) : fail(driverError(taken.error));
}

/** The part of the screen a swipe or scroll works in: a target's visible frame, else the whole screen. */
export async function regionOf(
	session: OpSession,
	driver: Driver,
	from: string | undefined
): Promise<Result<{ rect: Rect; screen: ScreenInfo }, WardenError>> {
	const screen = await currentScreen(driver);
	if (!screen.success) return screen;
	if (from === undefined) return ok({ rect: screenRect(screen.data), screen: screen.data });
	const target = parseTarget(from);
	if (!target.success) return target;
	const resolved = await pointAt(session, driver, target.data, false);
	if (!resolved.success) return resolved;
	if (!resolved.data.element) {
		return fail(opError("usage", "a region must be an element (@eN or a selector), not a point"));
	}
	return ok({ rect: visibleRect(resolved.data.element.frame, screen.data), screen: screen.data });
}

// ---- press -------------------------------------------------------------------------------------------------------

export type PressParams = {
	/** `@eN` | a selector (`id=… label=… nth=…`) | `x y` in screen coordinates */
	target: string;
	/** re-check an `@eN` against a fresh snapshot before tapping */
	verify?: boolean;
	/** wait for a quiet screen afterwards, up to this many ms */
	settleMs?: number;
};
export type PressResult = ActionResult;

/** `warden ui press|tap <target>`: tap an element or a point. `verify` re-checks an `@eN` against a fresh snapshot first. */
export async function press(session: OpSession, params: PressParams): OpOutcome<PressResult> {
	const target = targetOf(params.target);
	if (!target.success) return target;
	const driver = await session.driver();
	if (!driver.success) return driver;
	const resolved = await pointAt(session, driver.data, target.data, params.verify === true);
	if (!resolved.success) return resolved;
	const tapped = fromDriver(await driver.data.tap(resolved.data.point));
	if (!tapped.success) return tapped;
	const where = recordTarget(target.data, resolved.data);
	return finishAction(session, driver.data, params.settleMs, {
		action: "press",
		text: `pressed ${targetLabel(where)}`,
		target: where,
		...(resolved.data.verified === true || (params.verify === true && target.data.kind === "selector")
			? { verified: true }
			: {}),
	});
}

// ---- longPress ---------------------------------------------------------------------------------------------------

export type LongPressParams = PressParams & {
	/** how long to hold, in ms (default 800) */
	durationMs?: number;
};
export type LongPressResult = ActionResult & { durationMs: number };

/** `warden ui gesture longpress <target> [ms]`. */
export async function longPress(session: OpSession, params: LongPressParams): OpOutcome<LongPressResult> {
	const durationMs = params.durationMs ?? DEFAULT_LONGPRESS_MS;
	const target = targetOf(params.target);
	if (!target.success) return target;
	const driver = await session.driver();
	if (!driver.success) return driver;
	const resolved = await pointAt(session, driver.data, target.data, params.verify === true);
	if (!resolved.success) return resolved;
	const pressed = fromDriver(await driver.data.longPress(resolved.data.point, { durationMs }));
	if (!pressed.success) return pressed;
	const where = recordTarget(target.data, resolved.data);
	return finishAction(session, driver.data, params.settleMs, {
		action: "gesture-longpress",
		text: `long-pressed ${targetLabel(where)} for ${durationMs} ms`,
		target: where,
		args: { ms: durationMs },
		extra: { durationMs },
		...(resolved.data.verified === true || (params.verify === true && target.data.kind === "selector")
			? { verified: true }
			: {}),
	});
}

// ---- fill --------------------------------------------------------------------------------------------------------

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
	session: OpSession,
	driver: Driver,
	wanted: NodeEntry,
	text: string,
	limits: { budgetMs: number; maxMs: number }
): Promise<Result<FillRun, WardenError>> {
	const outcome = await confirmFieldValue<WardenError>({
		text,
		now: session.host.now,
		sleep: session.host.sleep,
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
	if (outcome.status === "failed") return fail(outcome.error);
	return ok(outcome.status === "confirmed" ? { ok: true } : { ok: false, held: outcome.held });
}

/**
 * What the field shows now, or undefined when it cannot be found. First a hit-test at the field (≈10 ms; a full
 * snapshot takes 300-1000 ms and starves the app of the very key events being read back), then a snapshot.
 */
async function readField(driver: Driver, wanted: NodeEntry): Promise<Result<string | undefined, WardenError>> {
	const hit = await hitTestField(driver, wanted);
	if (hit.ok && hit.entry) return ok(fieldValue(hit.entry));
	const fresh = await driver.snapshot();
	if (!fresh.success) return fail(driverError(fresh.error));
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
	/** how the first attempt puts the text in; the retry always types */
	via: FillVia;
	budgetMs: number;
	maxMs: number;
};

/** The error of a fill that did not take on the retry. */
function fillMismatch(text: string, held: string): WardenError {
	return opError(
		"failed",
		`fill did not take: expected ${JSON.stringify(text)} but the field holds ${JSON.stringify(held)}`,
		{ details: { expected: text, held } }
	);
}

/** One focus + clear + type pass (first attempt selects all where the driver can, the retry backspaces); read back when `readable`. */
async function fillAttempt(
	session: OpSession,
	driver: Driver,
	resolved: ResolvedTarget,
	plan: FillPlan,
	attempt: number
): Promise<Result<FillRun | undefined, WardenError>> {
	const { entry, text } = plan;
	const method: ClearMethod = attempt === 1 ? "auto" : "counted";
	const typed = fromDriver(
		await focusClearType(
			driver,
			session.host.sleep,
			caretPoint(resolved),
			entry,
			text,
			method,
			setTextOptedIn(session.host.env),
			attempt === 1 ? plan.via : "type"
		)
	);
	if (!typed.success) return typed;
	if (!(plan.verify && !plan.secure && entry !== undefined)) return ok(undefined);
	return readBack(session, driver, entry, text, { budgetMs: plan.budgetMs, maxMs: plan.maxMs });
}

/**
 * Focus, empty and type; with `verify` read the field back and retry once, backspacing one key per character that
 * time (the first attempt selects all where the driver can). Resolves to what `fill` reports as `verified`.
 */
async function typeAndConfirm(
	session: OpSession,
	driver: Driver,
	resolved: ResolvedTarget,
	plan: FillPlan
): Promise<Result<boolean | "unconfirmed" | undefined, WardenError>> {
	const readable = plan.verify && !plan.secure && plan.entry !== undefined;
	const attempts = readable ? 2 : 1;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		const run = await fillAttempt(session, driver, resolved, plan, attempt);
		if (!run.success) return run;
		if (run.data === undefined) break;
		if (run.data.ok) return ok(true);
		if (attempt === attempts) return fail(fillMismatch(plan.text, run.data.held));
	}
	return ok(plan.verify ? "unconfirmed" : undefined);
}

export type FillParams = {
	target: string;
	text: string;
	/** password field: skip the read-back, never echo or record the text */
	secure?: boolean;
	/** read the field back after typing (default true) */
	verify?: boolean;
	/** `paste` (iOS) pastes the text with one Cmd+V instead of typing per key; the retry always types. Default `type` */
	via?: FillVia;
	settleMs?: number;
};
export type FillResult = ActionResult & { characters: number; secure?: true };

/**
 * `warden ui fill <target> <text>`: focus the field, empty it, type, then read it back (retrying once).
 * `secure` (and fields the OS marks secure) cannot be read back: reported as `unconfirmed`, and the
 * text is neither echoed nor recorded. `verify: false` skips the read-back. `via: "paste"` (default `"type"`) pastes the
 * text on iOS (one Cmd+V, through the pasteboard Xcode syncs with the Mac clipboard) instead of typing per key; the
 * retry always types. Only `via: "paste"` is recorded.
 */
export async function fill(session: OpSession, params: FillParams): OpOutcome<FillResult> {
	const { text } = params;
	const target = targetOf(params.target);
	if (!target.success) return target;
	const driver = await session.driver();
	if (!driver.success) return driver;
	const resolved = await pointAt(session, driver.data, target.data, false);
	if (!resolved.success) return resolved;
	const entry = resolved.data.element
		? entryOfElement(resolved.data.element, { platform: session.device.platform })
		: undefined;
	const secure = params.secure === true || entry?.secure === true;
	const via = params.via ?? "type";

	const filled = await typeAndConfirm(session, driver.data, resolved.data, {
		entry,
		secure,
		text,
		verify: params.verify ?? true,
		via,
		budgetMs: Math.min(FILL_VERIFY_MS, session.timeoutMs),
		maxMs: session.timeoutMs,
	});
	if (!filled.success) return filled;
	const verified = filled.data;
	const where = recordTarget(target.data, resolved.data);
	const shown = secure ? `${[...text].length} characters (secure)` : JSON.stringify(text);
	return finishAction(session, driver.data, params.settleMs, {
		action: "fill",
		text: `filled ${targetLabel(where)} with ${shown}${verified === "unconfirmed" ? " (unconfirmed)" : ""}`,
		target: where,
		...(verified !== undefined ? { verified } : {}),
		args: { ...(secure ? { secure: true } : { text }), ...(via === "paste" ? { via } : {}) },
		...(secure ? { secret: text } : {}),
		extra: { characters: [...text].length, ...(secure ? { secure: true as const } : {}) },
	});
}

// ---- type / key --------------------------------------------------------------------------------------------------

export type TypeParams = { text: string; submit?: boolean; settleMs?: number };
export type TypeResult = ActionResult & { characters: number; submitted: boolean };

/** `warden ui type <text> [--submit]`: type into whatever has focus; `submit` then presses Enter. */
export async function type(session: OpSession, params: TypeParams): OpOutcome<TypeResult> {
	const { text } = params;
	const driver = await session.driver();
	if (!driver.success) return driver;
	const typed = fromDriver(await typeText(driver.data, session.host.sleep, text));
	if (!typed.success) return typed;
	if (params.submit === true) {
		const submitted = fromDriver(await driver.data.key("Enter"));
		if (!submitted.success) return submitted;
	}
	return finishAction(session, driver.data, params.settleMs, {
		action: "type",
		text: `typed ${JSON.stringify(text)}${params.submit === true ? " and pressed Enter" : ""}`,
		args: { text, ...(params.submit === true ? { submit: true } : {}) },
		extra: { characters: [...text].length, submitted: params.submit === true },
	});
}

export type KeyParams = { key: string; settleMs?: number };
export type KeyResult = ActionResult & { key: KeyName };

/** `warden ui key <name>`. */
export async function key(session: OpSession, params: KeyParams): OpOutcome<KeyResult> {
	const name = parseKey(params.key);
	if (!name.success) return name;
	const driver = await session.driver();
	if (!driver.success) return driver;
	const pressed = fromDriver(await driver.data.key(name.data));
	if (!pressed.success) return pressed;
	return finishAction(session, driver.data, params.settleMs, {
		action: "key",
		text: `pressed ${name.data}`,
		args: { key: name.data },
		extra: { key: name.data },
	});
}

// ---- swipe -------------------------------------------------------------------------------------------------------

export type SwipeParams = (
	| {
			/** the way the finger moves (`up` reveals what is below) */
			direction: Way;
			/** swipe inside this element (`@eN` or selector) instead of the whole screen */
			within?: string;
	  }
	| { from: Point; to: Point }
) & { settleMs?: number };
export type SwipeResult = ActionResult & { from: Point; to: Point };

/**
 * `warden ui gesture swipe`: a raw finger swipe. A direction is the way the finger moves (`up` moves content up,
 * revealing what is below), optionally inside an element; or two points.
 */
export async function swipe(session: OpSession, params: SwipeParams): OpOutcome<SwipeResult> {
	const driver = await session.driver();
	if (!driver.success) return driver;
	let from: Point;
	let to: Point;
	let label: string;
	if ("direction" in params) {
		const region = await regionOf(session, driver.data, params.within);
		if (!region.success) return region;
		({ from, to } = fingerPath(params.direction, region.data.rect, DEFAULT_SCROLL_AMOUNT));
		label = params.direction;
	} else {
		from = params.from;
		to = params.to;
		label = `(${from.x},${from.y}) to (${to.x},${to.y})`;
	}
	const swiped = fromDriver(await driver.data.swipe(from, to, { durationMs: SWIPE_MS, momentum: false }));
	if (!swiped.success) return swiped;
	return finishAction(session, driver.data, params.settleMs, {
		action: "gesture-swipe",
		text: `swiped ${label}`,
		args: { from: `${from.x},${from.y}`, to: `${to.x},${to.y}` },
		extra: { from, to },
	});
}

export function parseAmount(raw: string | undefined): Result<number, WardenError> {
	if (raw === undefined) return ok(DEFAULT_SCROLL_AMOUNT);
	const amount = Number(raw);
	if (!Number.isFinite(amount) || amount <= 0 || amount > 1) {
		return fail(opError("usage", `amount must be above 0 and at most 1 (a share of the region), got "${raw}"`));
	}
	return ok(amount);
}
