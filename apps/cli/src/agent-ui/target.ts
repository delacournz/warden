import type { Driver, Element, Point, Rect, Snapshot } from "@delacour/warden-e2e/driver/driver.types";
import { assignRefs, isRef } from "@delacour/warden-e2e/driver/refs";
import { coverOf } from "@delacour/warden-e2e/screen/keyboard-cover";
import { indexSnapshot, type NodeEntry, type NodeIndex } from "@delacour/warden-e2e/screen/nodes";
import { describeEntry } from "@delacour/warden-e2e/screen/render";
import {
	formatSelector,
	matchesSelector,
	type ParsedSelector,
	parseSelector,
	pickMostSpecific,
} from "@delacour/warden-e2e/screen/selector";
import { ok, type Result } from "@delacour/warden-types/result";
import { driverUiError } from "./driver";
import { type UiError, uiError } from "./output";
import type { StoredSnapshot } from "./state";

/** An `@eN` taken from a snapshot older than this is re-verified against a fresh snapshot before it is acted on. */
export const REF_MAX_AGE_MS = 30_000;

/** What an action points at: `@eN` | a selector (`id=… label=… nth=…`) | `x y` in screen coordinates. */
export type Target =
	| { kind: "ref"; ref: string }
	| { kind: "selector"; selector: ParsedSelector }
	| { kind: "point"; point: Point };

export type ResolvedTarget = {
	kind: Target["kind"];
	point: Point;
	element?: Element;
	ref?: string;
	/** the ref was checked against a fresh snapshot */
	verified?: boolean;
	/** the snapshot `element` belongs to (the stored one for a plain `@eN`, else the fresh one) */
	snapshot?: Snapshot;
};

const POINT = /^(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)$/;

/** Parse the words after a subcommand (`@e3`, `id=sign-in`, `120 340`) as one target. */
export function parseTarget(text: string): Result<Target, UiError> {
	const trimmed = text.trim();
	if (isRef(trimmed)) return ok({ kind: "ref", ref: trimmed });
	const point = POINT.exec(trimmed);
	if (point) return ok({ kind: "point", point: { x: Number(point[1]), y: Number(point[2]) } });
	const selector = parseSelector(trimmed);
	if (!selector.success) {
		return {
			success: false,
			error: uiError("usage", `bad target "${trimmed}": ${selector.error}`, {
				hint: "use @eN, a selector (id=… label=… text=… role=… value=… editable=… nth=…) or `x y`",
			}),
		};
	}
	return ok({ kind: "selector", selector: selector.data });
}

function centre(element: Element): Point {
	return (
		element.tapPoint ?? { x: element.frame.x + element.frame.width / 2, y: element.frame.y + element.frame.height / 2 }
	);
}

const SNAPSHOT_AGAIN = "run `warden ui snapshot` again";

function sameRole(entry: NodeEntry, wanted: NodeEntry): boolean {
	return entry.role === wanted.role;
}

/**
 * Where an element of an older snapshot is now: same identifier, else same role + name, else same path
 * (and role). Several candidates for one key: the first in document order.
 */
export function findInFresh(wanted: NodeEntry, fresh: NodeIndex): NodeEntry | undefined {
	const id = wanted.element.identifier;
	if (id !== undefined && id !== "") {
		const byId = fresh.entries.find((entry) => entry.element.identifier === id && sameRole(entry, wanted));
		if (byId) return byId;
	}
	if (wanted.name !== undefined) {
		const byName = fresh.entries.find((entry) => sameRole(entry, wanted) && entry.name === wanted.name);
		if (byName) return byName;
	}
	return fresh.entries.find((entry) => entry.element.id === wanted.element.id && sameRole(entry, wanted));
}

function staleRef(ref: string, why: string): UiError {
	return uiError("stale_ref", `${ref} ${why}`, { hint: SNAPSHOT_AGAIN });
}

export type ResolveContext = {
	/** the device's stored `last-snapshot.json` */
	lastSnapshot: StoredSnapshot | undefined;
	/** the device's input count now (`readInputs`); a stored snapshot with a lower count predates an input. Absent = 0 */
	inputs?: number;
	/** `ctx.now()` ms */
	now: number;
	/** `--verify`: re-check an `@eN` even when it is recent */
	verify: boolean;
	driver: Driver;
};

/** Same frame to 1 pt. */
function sameFrame(a: Rect, b: Rect): boolean {
	return (
		Math.abs(a.x - b.x) <= 1 &&
		Math.abs(a.y - b.y) <= 1 &&
		Math.abs(a.width - b.width) <= 1 &&
		Math.abs(a.height - b.height) <= 1
	);
}

/** The hit is the element the snapshot had: same role, identifier, label, enabled state and frame. */
function sameElement(hit: Element, seen: Element): boolean {
	return (
		hit.role === seen.role &&
		hit.identifier === seen.identifier &&
		hit.label === seen.label &&
		hit.enabled === seen.enabled &&
		sameFrame(hit.frame, seen.frame)
	);
}

/** Where `wanted` is in a fresh snapshot, or why it cannot be told. */
type Relocated =
	| { kind: "found"; entry: NodeEntry }
	| { kind: "gone" }
	| { kind: "ambiguous"; was: number; now: number };

/**
 * Strict re-find for a ref taken before an input: by identifier, else role + name, else path. The n-th of several
 * equal elements stays the n-th only while their count is the same; a count that changed (one "Next" before, two now)
 * is ambiguous. A key with no fresh match falls through to the next one. The place in the tree is only asked for an
 * element with neither: one whose identity is known and gone (Next replaced by Get started at that spot) is gone.
 */
export function relocate(wanted: NodeEntry, before: NodeIndex, fresh: NodeIndex): Relocated {
	const id = wanted.element.identifier;
	const keys: Array<(entry: NodeEntry) => boolean> = [];
	if (id !== undefined && id !== "") keys.push((entry) => sameRole(entry, wanted) && entry.element.identifier === id);
	if (wanted.name !== undefined) keys.push((entry) => sameRole(entry, wanted) && entry.name === wanted.name);
	for (const matches of keys) {
		const now = fresh.entries.filter(matches);
		if (now.length === 0) continue;
		const was = before.entries.filter(matches);
		const at = was.findIndex((entry) => entry.element.id === wanted.element.id);
		const entry = now.length === was.length ? now[at] : undefined;
		return entry ? { kind: "found", entry } : { kind: "ambiguous", was: was.length, now: now.length };
	}
	if (keys.length > 0) return { kind: "gone" };
	const byPath = fresh.entries.find((entry) => entry.element.id === wanted.element.id && sameRole(entry, wanted));
	return byPath ? { kind: "found", entry: byPath } : { kind: "gone" };
}

/** `strict` (after an input): `relocate`; else the lenient first match of `findInFresh`. */
function refind(wanted: NodeEntry, before: NodeIndex, fresh: NodeIndex, strict: boolean): Relocated {
	if (strict) return relocate(wanted, before, fresh);
	const entry = findInFresh(wanted, fresh);
	return entry ? { kind: "found", entry } : { kind: "gone" };
}

type StoredRef = { ref: string; element: Element; stored: StoredSnapshot };

/** The pre-input check: one hit-test where that is cheap (iOS, ~10 ms), else / on a miss a fresh snapshot. */
async function recheckAfterInput(at: StoredRef, driver: Driver): Promise<Result<ResolvedTarget, UiError>> {
	if (driver.capabilities.cheapHitTest === true) {
		const hit = await driver.elementAtPoint(centre(at.element));
		if (hit.success && hit.data !== null && sameElement(hit.data, at.element)) {
			return ok({
				kind: "ref",
				ref: at.ref,
				element: at.element,
				point: centre(at.element),
				verified: true,
				snapshot: at.stored.snapshot,
			});
		}
	}
	return recheckInFresh(at, driver, true);
}

/** Find the ref's element in a fresh snapshot and use its current frame; `strict` = after an input (no guessing). */
async function recheckInFresh(
	at: StoredRef,
	driver: Driver,
	strict: boolean
): Promise<Result<ResolvedTarget, UiError>> {
	const { ref, element, stored } = at;
	const fresh = await driver.snapshot();
	if (!fresh.success) return { success: false, error: driverUiError(fresh.error) };
	const before = indexSnapshot(stored.snapshot);
	const wanted = before.byId.get(element.id);
	const seen = wanted ? describeEntry(wanted) : element.id;
	const found = wanted ? refind(wanted, before, indexSnapshot(fresh.data), strict) : { kind: "gone" as const };
	if (found.kind === "gone") return { success: false, error: staleRef(ref, `(${seen}) is no longer on screen`) };
	if (found.kind === "ambiguous") {
		return {
			success: false,
			error: staleRef(ref, `(${seen}) now matches ${found.now} elements (${found.was} before)`),
		};
	}
	const point = centre(found.entry.element);
	if (coverOf(found.entry, point, fresh.data) !== undefined) {
		return {
			success: false,
			error: uiError("stale_ref", `${ref} (${seen}) is under the keyboard`, {
				hint: "dismiss the keyboard or scroll the element clear of it, then run `warden ui snapshot` again",
			}),
		};
	}
	return ok({ kind: "ref", ref, element: found.entry.element, point, verified: true, snapshot: fresh.data });
}

/**
 * An `@eN` from the stored snapshot. Used as stored while it is recent and no input (tap, typing, swipe, launch…)
 * reached the device since it was taken. After an input it is re-checked (hit-test, else fresh snapshot, strict match)
 * and the current frame is used; older than `REF_MAX_AGE_MS` or `--verify` re-finds it in a fresh snapshot.
 */
async function resolveRef(ref: string, rc: ResolveContext): Promise<Result<ResolvedTarget, UiError>> {
	const { lastSnapshot } = rc;
	if (!lastSnapshot) return { success: false, error: staleRef(ref, "has no snapshot to point into") };
	const element = assignRefs(lastSnapshot.snapshot, lastSnapshot.generation).byRef.get(ref);
	if (!element)
		return { success: false, error: staleRef(ref, `is not in snapshot generation ${lastSnapshot.generation}`) };
	const at: StoredRef = { ref, element, stored: lastSnapshot };
	const old = rc.now - lastSnapshot.takenAt > REF_MAX_AGE_MS;
	const afterInput = (lastSnapshot.inputs ?? 0) < (rc.inputs ?? 0);
	if (old || rc.verify) return recheckInFresh(at, rc.driver, afterInput);
	if (afterInput) return recheckAfterInput(at, rc.driver);
	return ok({ kind: "ref", ref, element, point: centre(element), snapshot: lastSnapshot.snapshot });
}

/** Matches of a selector in a snapshot index: `nth=` picks one, else the most specific visible one wins. */
export function pickBySelector(index: NodeIndex, selector: ParsedSelector): Result<NodeEntry, UiError> {
	const { nth, ...rest } = selector;
	const matches = index.entries.filter((entry) => matchesSelector(entry, rest));
	const picked = nth === undefined ? pickMostSpecific(matches, rest) : matches[nth];
	if (picked) return ok(picked);
	const wanted = formatSelector(selector);
	return {
		success: false,
		error: uiError(
			"target_not_found",
			nth !== undefined && matches.length > 0
				? `${wanted}: only ${matches.length} match${matches.length === 1 ? "" : "es"}, no nth=${nth}`
				: `${wanted} matched nothing`,
			{ hint: "run `warden ui snapshot -i` to see what is on screen" }
		),
	};
}

async function resolveSelector(selector: ParsedSelector, rc: ResolveContext): Promise<Result<ResolvedTarget, UiError>> {
	const fresh = await rc.driver.snapshot();
	if (!fresh.success) return { success: false, error: driverUiError(fresh.error) };
	const picked = pickBySelector(indexSnapshot(fresh.data), selector);
	if (!picked.success) return picked;
	return ok({
		kind: "selector",
		element: picked.data.element,
		point: centre(picked.data.element),
		snapshot: fresh.data,
	});
}

/** The element + tap point a target stands for. Refs come from the stored snapshot; selectors always from a fresh one. */
export async function resolveTarget(target: Target, rc: ResolveContext): Promise<Result<ResolvedTarget, UiError>> {
	switch (target.kind) {
		case "point":
			return ok({ kind: "point", point: target.point });
		case "ref":
			return resolveRef(target.ref, rc);
		case "selector":
			return resolveSelector(target.selector, rc);
	}
}
