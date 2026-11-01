import { type SnapshotParams, snapshotOps } from "@delacour/warden-sdk/ops/snapshot";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { uiArgs } from "./args";
import type { UiDeps } from "./driver";
import type { UiError } from "./output";
import { type UiOptionValues, uiRun } from "./run";
import { uiSession } from "./session";
import { uiStatePersistence } from "./state";

export type SnapshotOptionValues = UiOptionValues & {
	interactive?: true;
	all?: true;
	/** `--settle` alone = true, `--settle 5000` = "5000" */
	settle?: true | string;
	depth?: string;
};

export class UiSnapshotCommand {
	private parseParams(opts: SnapshotOptionValues, recording: boolean): Result<SnapshotParams, UiError> {
		const params: SnapshotParams = {
			interactiveOnly: opts.interactive === true,
			all: opts.all === true,
			...(recording ? { markMissingIds: true } : {}),
		};
		if (opts.depth !== undefined) {
			const depth = uiArgs.positiveInt("--depth", opts.depth);
			if (!depth.success) return depth;
			params.depth = depth.data;
		}
		const settle = uiArgs.parseSettle(opts.settle);
		if (!settle.success) return settle;
		if (settle.data !== undefined) params.settleMs = settle.data;
		return resultFactory.ok(params);
	}

	/** `warden ui snapshot [-i] [--all] [--settle [ms]] [--depth n]`: the screen as `@eN` lines; bumps the generation. */
	uiSnapshot(ctx: CommandContext, deps: UiDeps, opts: SnapshotOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "snapshot", opts, async (device, env) => {
			const params = this.parseParams(opts, uiStatePersistence.readState(ctx, device.udid).recording !== undefined);
			if (!params.success) return params;
			return uiSession.reply(
				device,
				await snapshotOps.snapshot(uiSession.opSessionFor(ctx, deps, device, env), params.data)
			);
		});
	}

	/** `warden ui find <selector…>`: elements matching a selector, with refs; bumps the generation. */
	uiFind(ctx: CommandContext, deps: UiDeps, words: string[], opts: UiOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "find", opts, async (device, env) =>
			uiSession.reply(
				device,
				await snapshotOps.find(uiSession.opSessionFor(ctx, deps, device, env), { selector: words.join(" ") })
			)
		);
	}
}

export const uiSnapshotCommand = new UiSnapshotCommand();
