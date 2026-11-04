import type { Element, Platform, Snapshot } from "../driver/driver.types";
import type { Announcement } from "./a11y.types";
import { type AnnounceOptions, accessibleName, announce, isActionable } from "./speech";

/**
 * Reading order a screen reader would walk. SIMULATED: approximates, not equals, VoiceOver / TalkBack.
 * Only reachable nodes are listed: `a11y.important !== false`, not hidden, on screen, and named or actionable.
 * Children of a focusable node are merged into it (no double entries). iOS: `a11y.order`, then siblings row-major
 * by frame (VoiceOver heuristic). `a11y.traversal` (the injected UIView walk) is subview order, not VoiceOver's: a nav
 * bar mounted after the content is walked last but read first, so it never sorts. Android keeps tree order.
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

function hasSpokenDescendant(el: Element, platform: Platform): boolean {
	return el.children.some(
		(c) =>
			!c.hidden &&
			(isActionable(c, platform) || accessibleName(c, platform) !== undefined || hasSpokenDescendant(c, platform))
	);
}

/**
 * Roles screen readers walk into but never stop on: app and window roots (they carry the app's name) and containers
 * (a UIKit accessibility container / an Android ViewGroup), whose label VoiceOver only reads on the way in. An
 * actionable one is still a stop.
 */
const CONTAINERS: ReadonlySet<Element["role"]> = new Set([
	"application",
	"window",
	"toolbar",
	"navbar",
	"tabbar",
	"list",
	"scrollview",
]);

/**
 * Whether `el` is read as one stop that covers its subtree. Actionable: unless a descendant is actionable too.
 * Not actionable: when the platform says it is one element (`a11y.focusable`), or nothing under it speaks.
 */
function swallows(el: Element, platform: Platform, actionable: boolean): boolean {
	if (actionable) return !hasActionableDescendant(el, platform);
	return el.a11y?.focusable === true || !hasSpokenDescendant(el, platform);
}

type Entry = { el: Element; announcement: Announcement };

function walk(el: Element, platform: Platform, screen: Screen, opts: AnnounceOptions, out: Entry[]): void {
	if (el.hidden) return;
	const visible = el.a11y?.important !== false && onScreen(el, screen);
	if (visible) {
		const actionable = isActionable(el, platform);
		const container = CONTAINERS.has(el.role) && !actionable;
		const named = accessibleName(el, platform) !== undefined;
		if (!container && (actionable || named)) {
			if (swallows(el, platform, actionable)) {
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
	return out.map((e) => e.announcement);
}
