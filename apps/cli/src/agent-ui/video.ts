import { video } from "@delacour/warden-sdk/ops/video";
import type { CommandContext } from "../context";
import type { UiDeps } from "./driver";
import { runUi, type UiOptionValues } from "./run";
import { opSessionFor, reply } from "./session";

/** `warden ui screen video start [path]` / `video stop`: see the `video` op. */
export function uiVideo(
	ctx: CommandContext,
	deps: UiDeps,
	what: string,
	pathArg: string | undefined,
	opts: UiOptionValues
): Promise<number> {
	return runUi(ctx, deps, "screen video", opts, async (device, env) =>
		reply(
			device,
			await video(opSessionFor(ctx, deps, device, env), {
				action: what,
				...(pathArg !== undefined ? { path: pathArg } : {}),
			})
		)
	);
}
