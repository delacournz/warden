import type { Driver, Rect, ScreenInfo } from "@delacour/warden-e2e/driver/driver.types";
import { visibleRect } from "@delacour/warden-e2e/screen/actions";
import { indexSnapshot, type NodeEntry, type NodeIndex } from "@delacour/warden-e2e/screen/nodes";
import { renderEntryLine } from "@delacour/warden-e2e/screen/render";
import {
	formatSelector,
	matchesSelector,
	type ParsedSelector,
	parseSelector,
	pickMostSpecific,
} from "@delacour/warden-e2e/screen/selector";
import { ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { finishAction, parseSettle } from "./act";
import {
	DEFAULT_SCROLL_MAX,
	fingerPath,
	isWay,
	OPPOSITE,
	parseAmount,
	regionOf,
	SCROLL_PAUSE_MS,
	type ScrollOptionValues,
	SWIPE_MS,
	type Way,
} from "./actions";
import { driverUiError, fromDriver, type UiDeps } from "./driver";
import { type UiError, uiError } from "./output";
import { runUi } from "./run";
import { storeSnapshot } from "./snapshot";
import { positiveInt } from "./snapshot-command";

/** The match of `selector` that is on the screen: `nth=` picks among the visible ones, else the most specific wins. */
export function visibleMatch(index: NodeIndex, selector: ParsedSelector, screen: ScreenInfo): NodeEntry | undefined {
	const { nth, ...rest } = selector;
	const shown = index.entries.filter((entry) => {
		if (entry.states.hidden || !matchesSelector(entry, rest)) return false;
		const seen = visibleRect(entry.element.frame, screen);
		return seen.width > 0 && seen.height > 0;
	});
	return nth === undefined ? pickMostSpecific(shown, rest) : shown[nth];
}

type ScrollRequest = { way: Way; amount: number; max: number; until?: ParsedSelector };

function parseRequest(
	direction: string,
	amountRaw: string | undefined,
	opts: ScrollOptionValues
): Result<ScrollRequest, UiError> {
	if (!isWay(direction)) {
		return {
			success: false,
			error: uiError("usage", `unknown direction "${direction}"`, { hint: "up, down, left or right" }),
		};
	}
	const amount = parseAmount(amountRaw);
	if (!amount.success) return amount;
	const max = opts.max === undefined ? ok(DEFAULT_SCROLL_MAX) : positiveInt("--max", opts.max);
	if (!max.success) return max;
	if (opts.until === undefined) return ok({ way: direction, amount: amount.data, max: max.data });
	const until = parseSelector(opts.until);
	if (!until.success) {
		return { success: false, error: uiError("usage", `bad --until selector: ${until.error}`) };
	}
	return ok({ way: direction, amount: amount.data, max: max.data, until: until.data });
}

type Found = { ref: string | undefined; entry: NodeEntry };

type ScrollRun = { swipes: number; found?: Found };

/** One swipe, or (`until`) swipes until the selector is on screen, looking before each one, at most `max`. */
async function scrollLoop(
	ctx: CommandContext,
	deps: UiDeps,
	driver: Driver,
	udid: string,
	plan: ScrollRequest,
	area: { rect: Rect; screen: ScreenInfo }
): Promise<Result<ScrollRun, UiError>> {
	const path = fingerPath(OPPOSITE[plan.way], area.rect, plan.amount);
	const swipe = async () =>
		fromDriver(await driver.swipe(path.from, path.to, { durationMs: SWIPE_MS, momentum: false }));
	if (plan.until === undefined) {
		const swiped = await swipe();
		return swiped.success ? ok({ swipes: 1 }) : swiped;
	}
	for (let swipes = 0; ; swipes += 1) {
		const looked = await driver.snapshot();
		if (!looked.success) return { success: false, error: driverUiError(looked.error) };
		const entry = visibleMatch(indexSnapshot(looked.data), plan.until, area.screen);
		if (entry) {
			const stored = storeSnapshot(ctx, udid, looked.data);
			return ok({ swipes, found: { ref: stored.refs.byId.get(entry.element.id), entry } });
		}
		if (swipes >= plan.max) return ok({ swipes });
		const swiped = await swipe();
		if (!swiped.success) return swiped;
		await deps.sleep(SCROLL_PAUSE_MS);
	}
}

const plural = (n: number): string => `${n} scroll${n === 1 ? "" : "s"}`;

/**
 * `warden ui scroll <up|down|left|right> [amount] [--until <selector>] [--in <target>] [--max n]`: scroll the content
 * that way (`down` reveals what is below). `amount` is the share of the region one swipe travels (default 0.5).
 * `--until` swipes until the selector is on screen (at most `--max`, default 10) and prints its fresh `@eN`.
 */
export function uiScroll(
	ctx: CommandContext,
	deps: UiDeps,
	direction: string,
	amountRaw: string | undefined,
	opts: ScrollOptionValues
): Promise<number> {
	return runUi(ctx, deps, "scroll", opts, async (device, env) => {
		const settle = parseSettle(opts.settle);
		if (!settle.success) return settle;
		const plan = parseRequest(direction, amountRaw, opts);
		if (!plan.success) return plan;
		const driver = await env.driver();
		if (!driver.success) return driver;
		const area = await regionOf(ctx, driver.data, device.udid, opts.in);
		if (!area.success) return area;

		const ran = await scrollLoop(ctx, deps, driver.data, device.udid, plan.data, area.data);
		if (!ran.success) return ran;
		const { swipes, found } = ran.data;
		const { until } = plan.data;
		if (until && !found) {
			return {
				success: false,
				error: uiError("target_not_found", `${formatSelector(until)} not on screen after ${plural(swipes)}`, {
					hint: "raise --max, scroll the other way, or check the selector with `warden ui find`",
					details: { swipes },
				}),
			};
		}
		const frame = found?.entry.element.frame;
		const line = found ? renderEntryLine(found.entry, found.ref === undefined ? {} : { ref: found.ref }) : undefined;
		const where =
			found && frame && until
				? {
						...(found.ref !== undefined ? { ref: found.ref } : {}),
						selector: formatSelector(until),
						point: found.entry.element.tapPoint ?? { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 },
					}
				: undefined;
		return finishAction(ctx, deps, env, device, driver.data, settle.data, {
			action: "scroll",
			text: line === undefined ? `scrolled ${direction}` : `found after ${plural(swipes)}: ${line}`,
			...(where ? { target: where } : {}),
			args: { direction, amount: plan.data.amount, ...(until ? { until: formatSelector(until) } : {}) },
			extra: { direction, amount: plan.data.amount, swipes },
		});
	});
}
