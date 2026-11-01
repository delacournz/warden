import { isWay, parseAmount } from "@delacour/warden-sdk/ops/actions";
import { scroll } from "@delacour/warden-sdk/ops/scroll";
import { ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { type ActionOptionValues, parseSettle, positiveInt } from "./args";
import type { UiDeps } from "./driver";
import { type UiError, uiError } from "./output";
import { runUi } from "./run";
import { opSessionFor, reply } from "./session";

export type ScrollOptionValues = ActionOptionValues & { until?: string; in?: string; max?: string };

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
		const request = scrollRequest(direction, amountRaw, opts);
		if (!request.success) return request;
		return reply(
			device,
			await scroll(opSessionFor(ctx, deps, device, env), {
				...request.data,
				...(settle.data !== undefined ? { settleMs: settle.data } : {}),
			})
		);
	});
}

type ScrollParams = Parameters<typeof scroll>[1];

/** The op's params from the words and flags (everything but `--settle`); usage errors for a bad direction, amount or `--max`. */
function scrollRequest(
	direction: string,
	amountRaw: string | undefined,
	opts: ScrollOptionValues
): Result<ScrollParams, UiError> {
	if (!isWay(direction)) {
		return {
			success: false,
			error: uiError("usage", `unknown direction "${direction}"`, { hint: "up, down, left or right" }),
		};
	}
	const amount = parseAmount(amountRaw);
	if (!amount.success) return amount;
	const max = opts.max === undefined ? undefined : positiveInt("--max", opts.max);
	if (max && !max.success) return max;
	return ok({
		direction,
		amount: amount.data,
		...(max ? { max: max.data } : {}),
		...(opts.until !== undefined ? { until: opts.until } : {}),
		...(opts.in !== undefined ? { within: opts.in } : {}),
	});
}
