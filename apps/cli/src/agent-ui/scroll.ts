import { actionOps } from "@delacour/warden-sdk/ops/actions";
import { scrollOps } from "@delacour/warden-sdk/ops/scroll";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { type ActionOptionValues, uiArgs } from "./args";
import type { UiDeps } from "./driver";
import { type UiError, uiOutput } from "./output";
import { uiRun } from "./run";
import { uiSession } from "./session";

export type ScrollOptionValues = ActionOptionValues & { until?: string; in?: string; max?: string };

type ScrollParams = Parameters<typeof scrollOps.scroll>[1];

export class UiScroll {
	/**
	 * `warden ui scroll <up|down|left|right> [amount] [--until <selector>] [--in <target>] [--max n]`: scroll the content
	 * that way (`down` reveals what is below). `amount` is the share of the region one swipe travels (default 0.5).
	 * `--until` swipes until the selector is on screen (at most `--max`, default 10) and prints its fresh `@eN`.
	 */
	uiScroll(
		ctx: CommandContext,
		deps: UiDeps,
		direction: string,
		amountRaw: string | undefined,
		opts: ScrollOptionValues
	): Promise<number> {
		return uiRun.runUi(ctx, deps, "scroll", opts, async (device, env) => {
			const settle = uiArgs.parseSettle(opts.settle);
			if (!settle.success) return settle;
			const request = this.scrollRequest(direction, amountRaw, opts);
			if (!request.success) return request;
			return uiSession.reply(
				device,
				await scrollOps.scroll(uiSession.opSessionFor(ctx, deps, device, env), {
					...request.data,
					...(settle.data !== undefined ? { settleMs: settle.data } : {}),
				})
			);
		});
	}

	/** The op's params from the words and flags (everything but `--settle`); usage errors for a bad direction, amount or `--max`. */
	private scrollRequest(
		direction: string,
		amountRaw: string | undefined,
		opts: ScrollOptionValues
	): Result<ScrollParams, UiError> {
		if (!actionOps.isWay(direction)) {
			return {
				success: false,
				error: uiOutput.uiError("usage", `unknown direction "${direction}"`, { hint: "up, down, left or right" }),
			};
		}
		const amount = actionOps.parseAmount(amountRaw);
		if (!amount.success) return amount;
		const max = opts.max === undefined ? undefined : uiArgs.positiveInt("--max", opts.max);
		if (max && !max.success) return max;
		return resultFactory.ok({
			direction,
			amount: amount.data,
			...(max ? { max: max.data } : {}),
			...(opts.until !== undefined ? { until: opts.until } : {}),
			...(opts.in !== undefined ? { within: opts.in } : {}),
		});
	}
}

export const uiScroll = new UiScroll();
