import type { Driver, Element, Point, Snapshot } from "@delacour/warden-driver/driver.types";
import { refResolver } from "@delacour/warden-driver/refs";
import { type NodeEntry, type NodeIndex, nodeIndexer } from "@delacour/warden-screen/nodes";
import { snapshotRenderer } from "@delacour/warden-screen/render";
import { type ParsedSelector, selectorEngine } from "@delacour/warden-screen/selector";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { driverError, opError } from "./errors";
import type { StoredSnapshot } from "./ref-store";

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
export function parseTarget(text: string): Result<Target, WardenError> {
	const trimmed = text.trim();
	if (refResolver.isRef(trimmed)) return resultFactory.ok({ kind: "ref", ref: trimmed });
	const point = POINT.exec(trimmed);
	if (point) return resultFactory.ok({ kind: "point", point: { x: Number(point[1]), y: Number(point[2]) } });
	const selector = selectorEngine.parseSelector(trimmed);
	if (!selector.success) {
		return {
			success: false,
			error: opError("usage", `bad target "${trimmed}": ${selector.error}`, {
				hint: "use @eN, a selector (id=… label=… text=… role=… value=… editable=… nth=…) or `x y`",
			}),
		};
	}
	return resultFactory.ok({ kind: "selector", selector: selector.data });
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

function staleRef(ref: string, why: string): WardenError {
	return opError("stale_ref", `${ref} ${why}`, { hint: SNAPSHOT_AGAIN });
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

async function resolveRef(ref: string, rc: ResolveContext): Promise<Result<ResolvedTarget, WardenError>> {
	const { lastSnapshot } = rc;
	if (!lastSnapshot) return { success: false, error: staleRef(ref, "has no snapshot to point into") };
	const element = refResolver.assign(lastSnapshot.snapshot, lastSnapshot.generation).byRef.get(ref);
	if (!element)
		return { success: false, error: staleRef(ref, `is not in snapshot generation ${lastSnapshot.generation}`) };
	const old = rc.now - lastSnapshot.takenAt > REF_MAX_AGE_MS;
	if (!old && !rc.verify) {
		return resultFactory.ok({ kind: "ref", ref, element, point: centre(element), snapshot: lastSnapshot.snapshot });
	}

	const fresh = await rc.driver.snapshot();
	if (!fresh.success) return { success: false, error: driverError(fresh.error) };
	const wanted = nodeIndexer.indexSnapshot(lastSnapshot.snapshot).byId.get(element.id);
	const now = wanted ? findInFresh(wanted, nodeIndexer.indexSnapshot(fresh.data)) : undefined;
	if (!now) {
		const seen = wanted ? snapshotRenderer.describeEntry(wanted) : element.id;
		return { success: false, error: staleRef(ref, `(${seen}) is no longer on screen`) };
	}
	return resultFactory.ok({
		kind: "ref",
		ref,
		element: now.element,
		point: centre(now.element),
		verified: true,
		snapshot: fresh.data,
	});
}

/** Matches of a selector in a snapshot index: `nth=` picks one, else the most specific visible one wins. */
export function pickBySelector(index: NodeIndex, selector: ParsedSelector): Result<NodeEntry, WardenError> {
	const { nth, ...rest } = selector;
	const matches = index.entries.filter((entry) => selectorEngine.matchesSelector(entry, rest));
	const picked = nth === undefined ? selectorEngine.pickMostSpecific(matches, rest) : matches[nth];
	if (picked) return resultFactory.ok(picked);
	const wanted = selectorEngine.formatSelector(selector);
	return {
		success: false,
		error: opError(
			"target_not_found",
			nth !== undefined && matches.length > 0
				? `${wanted}: only ${matches.length} match${matches.length === 1 ? "" : "es"}, no nth=${nth}`
				: `${wanted} matched nothing`,
			{ hint: "run `warden ui snapshot -i` to see what is on screen" }
		),
	};
}

async function resolveSelector(
	selector: ParsedSelector,
	rc: ResolveContext
): Promise<Result<ResolvedTarget, WardenError>> {
	const fresh = await rc.driver.snapshot();
	if (!fresh.success) return { success: false, error: driverError(fresh.error) };
	const picked = pickBySelector(nodeIndexer.indexSnapshot(fresh.data), selector);
	if (!picked.success) return picked;
	return resultFactory.ok({
		kind: "selector",
		element: picked.data.element,
		point: centre(picked.data.element),
		snapshot: fresh.data,
	});
}

/** The element + tap point a target stands for. Refs come from the stored snapshot; selectors always from a fresh one. */
export async function resolveTarget(target: Target, rc: ResolveContext): Promise<Result<ResolvedTarget, WardenError>> {
	switch (target.kind) {
		case "point":
			return resultFactory.ok({ kind: "point", point: target.point });
		case "ref":
			return resolveRef(target.ref, rc);
		case "selector":
			return resolveSelector(target.selector, rc);
	}
}
