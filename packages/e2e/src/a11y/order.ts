import type { Element, Platform, Snapshot } from "../driver/driver.types";
import type { Announcement } from "./a11y.types";
import { type AnnounceOptions, accessibleName, announce, isActionable } from "./speech";

/**
 * Reading order a screen reader would walk. SIMULATED: approximates, not equals, VoiceOver / TalkBack.
 * Only reachable nodes are listed: `a11y.important !== false`, not hidden, on screen, and named or actionable.
 * Children of a focusable node are merged into it (no double entries). iOS: when every listed node carries
 * `a11y.traversal` (the injected walk, VoiceOver's own order) that order is used; otherwise `a11y.order`, then
 * siblings row-major by frame (VoiceOver heuristic). Android keeps tree order.
 */

type Screen = Snapshot["screen"];

function onScreen(el: Element, screen: Screen): boolean {
	const f = el.frame;
	if (f.width <= 0 || f.height <= 0) return false;
	return f.x < screen.width && f.y < screen.height && f.x + f.width > 0 && f.y + f.height > 0;
}

function verticalOverlap(a: Element, b: Element): number {
	const top = Math.max(a.frame.y, b.frame.y);
	const bottom = Math.min(a.frame.y + a.frame.height, b.frame.y + b.frame.height);
	return bottom - top;
}

/** Top-to-bottom, left-to-right; items whose vertical overlap exceeds half the shorter height share a row. */
function rowMajor(items: readonly Element[]): Element[] {
	const byTop = [...items].sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x);
	const rows: Element[][] = [];
	for (const el of byTop) {
		const row = rows.find((r) => {
			const anchor = r[0];
			return anchor !== undefined && verticalOverlap(anchor, el) > 0.5 * Math.min(anchor.frame.height, el.frame.height);
		});
		if (row) row.push(el);
		else rows.push([el]);
	}
	return rows.flatMap((r) => r.sort((a, b) => a.frame.x - b.frame.x));
}

function orderSiblings(children: readonly Element[], platform: Platform): readonly Element[] {
	if (platform === "android") return children;
	const explicit = children.filter((c) => c.a11y?.order !== undefined);
	if (explicit.length > 0) {
		const rest = children.filter((c) => c.a11y?.order === undefined);
		return [...explicit.sort((a, b) => (a.a11y?.order ?? 0) - (b.a11y?.order ?? 0)), ...rowMajor(rest)];
	}
	return rowMajor(children);
}

function hasActionableDescendant(el: Element, platform: Platform): boolean {
	return el.children.some((c) => !c.hidden && (isActionable(c, platform) || hasActionableDescendant(c, platform)));
}

type Entry = { el: Element; announcement: Announcement };

function walk(el: Element, platform: Platform, screen: Screen, opts: AnnounceOptions, out: Entry[]): void {
	if (el.hidden) return;
	const visible = el.a11y?.important !== false && onScreen(el, screen);
	if (visible) {
		const actionable = isActionable(el, platform);
		const named = accessibleName(el, platform) !== undefined;
		if (actionable || named) {
			const swallowsChildren = !actionable || !hasActionableDescendant(el, platform);
			if (swallowsChildren) {
				out.push({ el, announcement: announce(el, platform, opts) });
				return;
			}
			if (named) out.push({ el, announcement: announce(el, platform, opts) });
		}
	}
	for (const child of orderSiblings(el.children, platform)) walk(child, platform, screen, opts, out);
}

/** The announcements a swipe-right sweep would produce, in order. Every entry has `source: "simulated"`. */
export function readingOrder(snapshot: Snapshot, platform: Platform, opts: AnnounceOptions = {}): Announcement[] {
	const out: Entry[] = [];
	for (const el of orderSiblings(snapshot.elements, platform)) walk(el, platform, snapshot.screen, opts, out);
	const traversed = platform === "ios" && out.length > 0 && out.every((e) => e.el.a11y?.traversal !== undefined);
	if (traversed) out.sort((a, b) => (a.el.a11y?.traversal ?? 0) - (b.el.a11y?.traversal ?? 0));
	return out.map((e) => e.announcement);
}
