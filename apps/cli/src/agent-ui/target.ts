import type { Driver, Element, Point, Snapshot } from "@delacour/warden-e2e/driver/driver.types";
import { assignRefs, isRef } from "@delacour/warden-e2e/driver/refs";
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
	/** `ctx.now()` ms */
	now: number;
	/** `--verify`: re-check an `@eN` even when it is recent */
	verify: boolean;
	driver: Driver;
};

async function resolveRef(ref: string, rc: ResolveContext): Promise<Result<ResolvedTarget, UiError>> {
	const { lastSnapshot } = rc;
	if (!lastSnapshot) return { success: false, error: staleRef(ref, "has no snapshot to point into") };
	const element = assignRefs(lastSnapshot.snapshot, lastSnapshot.generation).byRef.get(ref);
	if (!element)
		return { success: false, error: staleRef(ref, `is not in snapshot generation ${lastSnapshot.generation}`) };
	const old = rc.now - lastSnapshot.takenAt > REF_MAX_AGE_MS;
	if (!old && !rc.verify) {
		return ok({ kind: "ref", ref, element, point: centre(element), snapshot: lastSnapshot.snapshot });
	}

	const fresh = await rc.driver.snapshot();
	if (!fresh.success) return { success: false, error: driverUiError(fresh.error) };
	const wanted = indexSnapshot(lastSnapshot.snapshot).byId.get(element.id);
	const now = wanted ? findInFresh(wanted, indexSnapshot(fresh.data)) : undefined;
	if (!now) {
		const seen = wanted ? describeEntry(wanted) : element.id;
		return { success: false, error: staleRef(ref, `(${seen}) is no longer on screen`) };
	}
	return ok({
		kind: "ref",
		ref,
		element: now.element,
		point: centre(now.element),
		verified: true,
		snapshot: fresh.data,
	});
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
