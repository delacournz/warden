import type { Point, Rect } from "../driver/driver.types";
import { tapPointOf } from "./actions";
import { scrollContainer } from "./keyboard-cover";
import type { NodeEntry, NodeIndex } from "./nodes";
import { isInteractiveRole } from "./roles";

/**
 * The accessibility tree has no z-order, but its document order is drawing order: a node that comes later is drawn
 * over an earlier one (a sticky footer, a tab bar, a floating button, a sheet's backdrop over the page). A control that
 * comes later and overlaps a target takes the touch meant for it, so a tap first finds a point of the target no such
 * control covers. Containers and text are not covers (they pass touches through, or are not what the tree says is
 * under the finger), nor are the target's own descendants or the on-screen keyboard's keys (the keyboard has its own
 * handling, `keyboard-cover.ts`).
 */

/** The narrowest strip of a target still worth tapping, in points. */
const MIN_CLEAR = 8;

/**
 * What keeps a tap off a target: a later control over it (`by: "control"`, `region` its panel), or the edge of the
 * scroll view it has been scrolled out of (`by: "edge"`, `region` the part of the screen past that edge).
 */
export type Blocker =
	| { by: "control"; cover: NodeEntry; region: Rect }
	| { by: "edge"; viewport: NodeEntry; region: Rect };

export type TapPointResult = { kind: "clear"; point: Point } | ({ kind: "covered" } & Blocker);

/** A wrapper this many times a control's area or more is a layout container, not the panel that draws it. */
const MAX_PANEL_GROWTH = 4;

type Span = [start: number, end: number];

function within(entry: NodeEntry, ancestor: NodeEntry): boolean {
	for (let node = entry.parent; node !== undefined; node = node.parent) if (node === ancestor) return true;
	return false;
}

function inKeyboard(entry: NodeEntry): boolean {
	for (let node: NodeEntry | undefined = entry; node !== undefined; node = node.parent) {
		if (node.element.role === "keyboard") return true;
	}
	return false;
}

function overlaps(a: Rect, b: Rect): boolean {
	return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function contains(rect: Rect, point: Point): boolean {
	return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

/** Controls drawn over `entry`'s frame: later in document order, visible, interactive, not its own, not keys. */
export function coversOf(entry: NodeEntry, index: NodeIndex): NodeEntry[] {
	const frame = entry.element.frame;
	return index.entries.filter(
		(other) =>
			other.position > entry.position &&
			other.visible &&
			isInteractiveRole(other.role) &&
			overlaps(other.element.frame, frame) &&
			!within(other, entry) &&
			!inKeyboard(other)
	);
}

function area(rect: Rect): number {
	return rect.width * rect.height;
}

/**
 * What a cover blocks: a control's frame is smaller than the view that draws it (a sticky footer's padded bar around
 * its button), and the padding takes the touch too. So the cover grows to its outermost wrapper that is not one of the
 * target's ancestors and is at most `MAX_PANEL_GROWTH` times its area (a full-screen overlay holding a floating button
 * stays the button).
 */
export function coverRegion(cover: NodeEntry, entry: NodeEntry): Rect {
	let region = cover.element.frame;
	const limit = area(region) * MAX_PANEL_GROWTH;
	for (let node = cover.parent; node !== undefined; node = node.parent) {
		if (node === entry || within(entry, node)) break;
		const frame = node.element.frame;
		if (area(frame) > limit) break;
		region = frame;
	}
	return region;
}

/** The parts of `[from, to]` no span in `taken` covers. */
function freeSpans(from: number, to: number, taken: readonly Span[]): Span[] {
	const sorted = [...taken].sort((a, b) => a[0] - b[0]);
	const free: Span[] = [];
	let at = from;
	for (const [start, end] of sorted) {
		if (start > at) free.push([at, Math.min(start, to)]);
		at = Math.max(at, end);
		if (at >= to) break;
	}
	if (at < to) free.push([at, to]);
	return free.filter(([start, end]) => end - start >= MIN_CLEAR);
}

function widest(spans: readonly Span[]): Span | undefined {
	let best: Span | undefined;
	for (const span of spans) if (best === undefined || span[1] - span[0] > best[1] - best[0]) best = span;
	return best;
}

/** `rect` cut to the screen. */
function onScreen(rect: Rect, index: NodeIndex): Rect {
	const x = Math.max(rect.x, 0);
	const y = Math.max(rect.y, 0);
	const right = Math.min(rect.x + rect.width, index.screen.width);
	const bottom = Math.min(rect.y + rect.height, index.screen.height);
	return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function overflows(child: Rect, parent: Rect): boolean {
	return child.y < parent.y - 1 || child.y + child.height > parent.y + parent.height + 1;
}

/**
 * The scroll view `entry` sits in: a `scrollview` ancestor, or else the nearest ancestor one of whose children runs
 * past it top or bottom (iOS shows a React Native ScrollView as a plain group with a taller content child). Content
 * outside it is clipped: the tree still calls it visible, but a touch there lands on whatever is drawn around the list
 * (a navigation header).
 */
export function viewportOf(entry: NodeEntry): NodeEntry | undefined {
	const declared = scrollContainer(entry);
	if (declared !== undefined) return declared;
	for (let child = entry; child.parent !== undefined; child = child.parent) {
		if (overflows(child.element.frame, child.parent.element.frame)) return child.parent;
	}
	return undefined;
}

/** A band as wide as `rect` past its top (`side: "above"`) or bottom edge, as tall as the screen. */
function pastEdge(rect: Rect, side: "above" | "below", index: NodeIndex): Rect {
	const height = index.screen.height;
	const y = side === "above" ? rect.y - height : rect.y + rect.height;
	return { x: rect.x, y, width: rect.width, height };
}

/** `rect` cut to `viewport` top and bottom. */
function clipY(rect: Rect, viewport: Rect): Rect {
	const y = Math.max(rect.y, viewport.y);
	const bottom = Math.min(rect.y + rect.height, viewport.y + viewport.height);
	return { ...rect, y, height: Math.max(0, bottom - y) };
}

/**
 * Where a tap reaches `entry` itself: its own tap point when no cover is over it, else the middle of the widest
 * uncovered strip on its vertical centre line, then on its horizontal one. `covered` (with the cover over its tap
 * point) when neither line has a strip of `MIN_CLEAR` points.
 */
export function clearTapPoint(entry: NodeEntry, index: NodeIndex): TapPointResult {
	const viewport = viewportOf(entry);
	const visible = viewport === undefined ? entry.element.frame : clipY(entry.element.frame, viewport.element.frame);
	if (viewport !== undefined && visible.height < MIN_CLEAR) {
		const vp = viewport.element.frame;
		const side = entry.element.frame.y + entry.element.frame.height / 2 < vp.y + vp.height / 2 ? "above" : "below";
		return { kind: "covered", by: "edge", viewport, region: pastEdge(vp, side, index) };
	}
	const tapPoint = tapPointOf(entry);
	// a target cut by its list's edge is aimed at the middle of what is left, not a point by the edge
	const own =
		visible.height === entry.element.frame.height ? tapPoint : { x: tapPoint.x, y: visible.y + visible.height / 2 };
	const regions = coversOf(entry, index).map((cover) => ({ cover, rect: coverRegion(cover, entry) }));
	const over = regions.find((r) => contains(r.rect, own));
	if (over === undefined) return { kind: "clear", point: own };
	const frame = onScreen(visible, index);
	const cx = frame.x + frame.width / 2;
	const cy = frame.y + frame.height / 2;
	const vertical = widest(
		freeSpans(
			frame.y,
			frame.y + frame.height,
			regions
				.filter(({ rect }) => rect.x <= cx && cx <= rect.x + rect.width)
				.map(({ rect }): Span => [rect.y, rect.y + rect.height])
		)
	);
	if (vertical !== undefined) return { kind: "clear", point: { x: cx, y: (vertical[0] + vertical[1]) / 2 } };
	const horizontal = widest(
		freeSpans(
			frame.x,
			frame.x + frame.width,
			regions
				.filter(({ rect }) => rect.y <= cy && cy <= rect.y + rect.height)
				.map(({ rect }): Span => [rect.x, rect.x + rect.width])
		)
	);
	if (horizontal !== undefined) return { kind: "clear", point: { x: (horizontal[0] + horizontal[1]) / 2, y: cy } };
	return { kind: "covered", by: "control", cover: over.cover, region: over.rect };
}

/** `button "Sign out" (id=sign-out)`: what a cover is, for an error message. */
export function describeCover(cover: NodeEntry): string {
	const name = cover.name === undefined ? "" : ` "${cover.name}"`;
	const id = cover.element.identifier === undefined ? "" : ` (id=${cover.element.identifier})`;
	return `${cover.role}${name}${id}`;
}

/** What blocks a tap, for an error message: `covered by button "Sign out"` or `scrolled out of its list`. */
export function describeBlocker(blocker: Blocker): string {
	return blocker.by === "control"
		? `covered by ${describeCover(blocker.cover)}`
		: `scrolled past the ${blocker.region.y < blocker.viewport.element.frame.y ? "top" : "bottom"} of its scroll view`;
}

/**
 * The finger path of a reveal drag: a steady 600 ms drag. A React Native ScrollView on iOS did not follow the
 * keyboard cover's 350 ms ease-out drag of a few dozen points at all; this one moves it by about what it asks.
 */
export const REVEAL_SWIPE = { durationMs: 600 };

/** Space left between a revealed target and its cover, in points. */
const REVEAL_MARGIN = 24;
/** Never start or end a reveal drag closer than this to the edge of the free part. */
const REVEAL_INSET = 12;
/** How far from the cover a reveal drag starts, in points. */
const REVEAL_CLEARANCE = 2 * REVEAL_MARGIN;

/**
 * The finger path that drags `entry` clear of `blocker` inside its scroll view (`viewportOf`): the content moves up
 * when the blocker sits low in it (a footer, a tab bar, content past the bottom), down when it sits high (a header,
 * content past the top). Undefined with no scroll view (`screenWhenUnknown` then drags the screen's free part, for
 * callers that scroll the screen anyway), or when the free part is too small to drag in. A shorter drag than needed
 * is fine: the caller looks again and drags again.
 */
export function revealPath(
	entry: NodeEntry,
	blocker: Blocker,
	index: NodeIndex,
	options: { screenWhenUnknown?: boolean } = {}
): { from: Point; to: Point } | undefined {
	const container = blocker.by === "edge" ? blocker.viewport : viewportOf(entry);
	if (container === undefined && options.screenWhenUnknown !== true) return undefined;
	const whole = { x: 0, y: 0, width: index.screen.width, height: index.screen.height };
	const box = onScreen(container?.element.frame ?? whole, index);
	const target = entry.element.frame;
	const over = blocker.region;
	const x = box.x + box.width / 2;
	// a footer or tab bar sits in the lower half of the container, a header in the upper: that, not the target's own
	// position (it may be almost wholly inside the cover), says which way to drag
	const below = over.y + over.height / 2 > box.y + box.height / 2;
	const top = below ? box.y : Math.max(box.y, over.y + over.height);
	const bottom = below ? Math.min(box.y + box.height, over.y) : box.y + box.height;
	const room = bottom - top - 2 * REVEAL_INSET;
	if (room <= 0) return undefined;
	const shift = below
		? target.y + target.height + REVEAL_MARGIN - over.y
		: over.y + over.height + REVEAL_MARGIN - target.y;
	const travel = Math.max(1, Math.min(shift, room));
	if (below) {
		// start well clear of the cover: a drag started just above a footer's bar scrolled nothing
		const from = Math.max(top + REVEAL_INSET, bottom - REVEAL_CLEARANCE);
		return { from: { x, y: from }, to: { x, y: Math.max(top + REVEAL_INSET, from - travel) } };
	}
	const from = top + REVEAL_INSET;
	return { from: { x, y: from }, to: { x, y: from + travel } };
}
