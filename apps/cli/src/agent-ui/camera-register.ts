import type { Command as Commander } from "@commander-js/extra-typings";
import type { CommandContext } from "../context";
import type { UiDeps } from "./driver";
import { withUiOptions } from "./ui-options";

const FACING = "back | front | both";

/**
 * `warden ui camera set | status | clear`: the simulated camera (an image or video fed into the app's real camera).
 * A command group like `network`; the state is the lease's `camera` condition, shared with `device.camera` in specs.
 * One call from `commands/ui.ts`; `camera.ts` is imported by the subcommand that runs.
 */
export function registerCameraGroup(
	cmd: Commander,
	ctx: CommandContext,
	done: (code: number) => void,
	deps: UiDeps
): void {
	const group = cmd
		.command("camera")
		.description("simulated camera: set <path> | status | clear (png, jpg, heic, mp4, mov into the app's camera)");
	withUiOptions(
		group
			.command("set")
			.description(
				"feed an image or video into the camera. iOS: live in an app launched with the camera, else from its next launch. Android emulator: needs a --camera device; an image shows on the app's next camera open, a video reboots the emulator"
			)
			.argument("<path>", "png | jpg | heic | mp4 | mov, relative to the working directory")
			.option("--facing <facing>", `${FACING} (default back)`)
			.option("--no-loop", "video: stop on the last frame instead of playing again")
	).action(async (path, opts) => {
		const { uiCamera } = await import("./camera");
		done(await uiCamera(ctx, deps, "set", path, opts));
	});
	withUiOptions(group.command("status").description("the feeds this lease's camera has")).action(async (opts) => {
		const { uiCamera } = await import("./camera");
		done(await uiCamera(ctx, deps, "status", undefined, opts));
	});
	withUiOptions(
		group
			.command("clear")
			.description("take the feed off one camera, or both (default)")
			.option("--facing <facing>", `${FACING} (default both)`)
	).action(async (opts) => {
		const { uiCamera } = await import("./camera");
		done(await uiCamera(ctx, deps, "clear", undefined, opts));
	});
}
