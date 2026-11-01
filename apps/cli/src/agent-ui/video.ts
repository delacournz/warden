import { videoOps } from "@delacour/warden-sdk/ops/video";
import type { CommandContext } from "../context";
import type { UiDeps } from "./driver";
import { type UiOptionValues, uiRun } from "./run";
import { uiSession } from "./session";

export class UiVideo {
	/** `warden ui screen video start [path]` / `video stop`: see the `video` op. */
	uiVideo(
		ctx: CommandContext,
		deps: UiDeps,
		what: string,
		pathArg: string | undefined,
		opts: UiOptionValues
	): Promise<number> {
		return uiRun.runUi(ctx, deps, "screen video", opts, async (device, env) =>
			uiSession.reply(
				device,
				await videoOps.video(uiSession.opSessionFor(ctx, deps, device, env), {
					action: what,
					...(pathArg !== undefined ? { path: pathArg } : {}),
				})
			)
		);
	}
}

export const uiVideo = new UiVideo();
