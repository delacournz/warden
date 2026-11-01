import type { Driver, Rect, ScreenInfo } from "@delacour/warden-driver/driver.types";
import { actionGeometry } from "@delacour/warden-screen/actions";
import { type NodeEntry, type NodeIndex, nodeIndexer } from "@delacour/warden-screen/nodes";
import { snapshotRenderer } from "@delacour/warden-screen/render";
import { type ParsedSelector, selectorEngine } from "@delacour/warden-screen/selector";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { type ActionResult, finishAction } from "./act";
import { DEFAULT_SCROLL_AMOUNT, DEFAULT_SCROLL_MAX, regionOf, SCROLL_PAUSE_MS, SWIPE_MS, type Way } from "./actions";
import { driverError, fail, fromDriver, opError } from "./errors";
import type { RecordTarget } from "./record";
import type { OpOutcome, OpSession } from "./session";
import { storeSnapshot } from "./snapshot";

/** The match of `selector` that is on the screen: `nth=` picks among the visible ones, else the most specific wins. */
export function visibleMatch(index: NodeIndex, selector: ParsedSelector, screen: ScreenInfo): NodeEntry | undefined {
	const { nth, ...rest } = selector;
	const shown = index.entries.filter((entry) => {
		if (entry.states.hidden || !selectorEngine.matchesSelector(entry, rest)) return false;
		const seen = actionGeometry.visibleRect(entry.element.frame, screen);
		return seen.width > 0 && seen.height > 0;
	});
	return nth === undefined ? selectorEngine.pickMostSpecific(shown, rest) : shown[nth];
}

type ScrollPlan = { way: Way; amount: number; max: number; until?: ParsedSelector };

type Found = { ref: string | undefined; entry: NodeEntry };

type ScrollRun = { swipes: number; found?: Found };

/** One swipe, or (`until`) swipes until the selector is on screen, looking before each one, at most `max`. */
async function scrollLoop(
	session: OpSession,
	driver: Driver,
	plan: ScrollPlan,
	area: { rect: Rect; screen: ScreenInfo }
): Promise<Result<ScrollRun, WardenError>> {
	const path = actionGeometry.contentPath(plan.way, area.rect, plan.amount);
	const swipe = async () =>
		fromDriver(await driver.swipe(path.from, path.to, { durationMs: SWIPE_MS, momentum: false }));
	if (plan.until === undefined) {
		const swiped = await swipe();
		return swiped.success ? resultFactory.ok({ swipes: 1 }) : swiped;
	}
	for (let swipes = 0; ; swipes += 1) {
		const looked = await driver.snapshot();
		if (!looked.success) return fail(driverError(looked.error));
		const entry = visibleMatch(nodeIndexer.indexSnapshot(looked.data), plan.until, area.screen);
		if (entry) {
			const stored = storeSnapshot(session, looked.data);
			return resultFactory.ok({ swipes, found: { ref: stored.refs.byId.get(entry.element.id), entry } });
		}
		if (swipes >= plan.max) return resultFactory.ok({ swipes });
		const swiped = await swipe();
		if (!swiped.success) return swiped;
		await session.host.sleep(SCROLL_PAUSE_MS);
	}
}

const plural = (n: number): string => `${n} scroll${n === 1 ? "" : "s"}`;

export type ScrollParams = {
	/** the content's direction: `down` reveals what is below */
	direction: Way;
	/** share of the region one swipe travels, 0-1 (default 0.5) */
	amount?: number;
	/** with `until`: give up after this many swipes (default 10) */
	max?: number;
	/** keep scrolling until this selector is on screen */
	until?: string;
	/** scroll inside this element (`@eN` or selector) */
	within?: string;
	settleMs?: number;
};
export type ScrollResult = ActionResult & { direction: Way; amount: number; swipes: number };

/** The element `--until` found, as the target the recording stores (the selector and a point to land on). */
function foundTarget(found: Found | undefined, until: ParsedSelector | undefined): RecordTarget | undefined {
	if (!found || !until) return undefined;
	const { entry, ref } = found;
	const { frame, tapPoint } = entry.element;
	return {
		...(ref !== undefined ? { ref } : {}),
		selector: selectorEngine.formatSelector(until),
		point: tapPoint ?? { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 },
	};
}

/** What `scroll` prints: the plain direction, or where `until` found its element. */
function scrollText(direction: Way, found: Found | undefined, swipes: number): string {
	if (!found) return `scrolled ${direction}`;
	const line = snapshotRenderer.renderEntryLine(found.entry, found.ref === undefined ? {} : { ref: found.ref });
	return `found after ${plural(swipes)}: ${line}`;
}

/** The parsed `until` selector, `undefined` without one, or a usage error for a bad one. */
function parseUntil(raw: string | undefined): Result<ParsedSelector | undefined, WardenError> {
	if (raw === undefined) return resultFactory.ok(undefined);
	const parsed = selectorEngine.parseSelector(raw);
	return parsed.success
		? resultFactory.ok(parsed.data)
		: fail(opError("usage", `bad --until selector: ${parsed.error}`));
}

/**
 * `warden ui scroll <up|down|left|right> [amount] [--until <selector>] [--in <target>] [--max n]`: scroll the content
 * that way (`down` reveals what is below). `until` swipes until the selector is on screen (at most `max`) and
 * reports its fresh `@eN`.
 */
export async function scroll(session: OpSession, params: ScrollParams): OpOutcome<ScrollResult> {
	const amount = params.amount ?? DEFAULT_SCROLL_AMOUNT;
	const max = params.max ?? DEFAULT_SCROLL_MAX;
	const parsedUntil = parseUntil(params.until);
	if (!parsedUntil.success) return parsedUntil;
	const until = parsedUntil.data;
	const plan: ScrollPlan = { way: params.direction, amount, max, ...(until ? { until } : {}) };
	const driver = await session.driver();
	if (!driver.success) return driver;
	const area = await regionOf(session, driver.data, params.within);
	if (!area.success) return area;

	const ran = await scrollLoop(session, driver.data, plan, area.data);
	if (!ran.success) return ran;
	const { swipes, found } = ran.data;
	if (until && !found) {
		return fail(
			opError("target_not_found", `${selectorEngine.formatSelector(until)} not on screen after ${plural(swipes)}`, {
				hint: "raise --max, scroll the other way, or check the selector with `warden ui find`",
				details: { swipes },
			})
		);
	}
	const where = foundTarget(found, until);
	return finishAction(session, driver.data, params.settleMs, {
		action: "scroll",
		text: scrollText(params.direction, found, swipes),
		...(where ? { target: where } : {}),
		args: { direction: params.direction, amount, ...(until ? { until: selectorEngine.formatSelector(until) } : {}) },
		extra: { direction: params.direction, amount, swipes },
	});
}
