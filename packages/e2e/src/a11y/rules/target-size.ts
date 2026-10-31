import type { Element, Snapshot } from "../../driver/driver.types";
import { isActionable } from "../speech";
import { describe, issue, type Rule, type RuleContext, related, unitsPerPoint } from "./rule.context";

export const WCAG_MIN = 24;
export const IOS_MIN = 44;
export const ANDROID_MIN = 48;
const RADIUS = WCAG_MIN / 2;

type Box = { el: Element; x: number; y: number; w: number; h: number };

/** Enabled, reachable actionable nodes in points / dp. Disabled controls are exempt from 2.5.8. */
function targets(snapshot: Snapshot, ctx: RuleContext): Box[] {
	const k = unitsPerPoint(snapshot);
	return ctx.reachable
		.filter((el) => el.enabled && isActionable(el, ctx.platform) && el.frame.width > 0 && el.frame.height > 0)
		.map((el) => ({ el, x: el.frame.x / k, y: el.frame.y / k, w: el.frame.width / k, h: el.frame.height / k }));
}

function centre(b: Box): { x: number; y: number } {
	return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

function distanceToBox(p: { x: number; y: number }, b: Box): number {
	const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w));
	const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h));
	return Math.hypot(dx, dy);
}

const undersized = (b: Box): boolean => b.w < WCAG_MIN || b.h < WCAG_MIN;

/**
 * WCAG 2.5.8 spacing exception, simplified: a 24 pt circle centred on each undersized target must not touch another
 * target (circle-to-circle for two undersized targets, circle-to-rectangle otherwise). Ancestors and descendants
 * of a target do not count as "another target". Sub-24 targets that pass the test are not reported.
 */
export function wcagFailures(snapshot: Snapshot, ctx: RuleContext): Box[] {
	const all = targets(snapshot, ctx);
	return all.filter((b) => {
		if (!undersized(b)) return false;
		const c = centre(b);
		return all.some((o) => {
			if (related(b.el, o.el, ctx.parents)) return false;
			if (undersized(o)) return Math.hypot(centre(o).x - c.x, centre(o).y - c.y) < RADIUS * 2;
			return distanceToBox(c, o) < RADIUS;
		});
	});
}

const fmt = (n: number): string => String(Math.round(n * 10) / 10);

export const targetSize: Rule = (snapshot, ctx) => {
	const unit = ctx.platform === "ios" ? "pt" : "dp";
	return wcagFailures(snapshot, ctx).map((b) =>
		issue(
			"target-size",
			"error",
			b.el,
			`${describe(b.el)} is ${fmt(b.w)}x${fmt(b.h)}${unit}, under ${WCAG_MIN}x${WCAG_MIN}${unit} with another target within ${WCAG_MIN}${unit}`,
			"2.5.8"
		)
	);
};

export const targetSizePlatform: Rule = (snapshot, ctx) => {
	const min = ctx.platform === "ios" ? IOS_MIN : ANDROID_MIN;
	const unit = ctx.platform === "ios" ? "pt" : "dp";
	const failing = new Set(wcagFailures(snapshot, ctx).map((b) => b.el));
	return targets(snapshot, ctx)
		.filter((b) => (b.w < min || b.h < min) && !failing.has(b.el))
		.map((b) =>
			issue(
				"target-size-platform",
				"warning",
				b.el,
				`${describe(b.el)} is ${fmt(b.w)}x${fmt(b.h)}${unit}, under the platform minimum ${min}${unit}`
			)
		);
};
