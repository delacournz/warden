import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, reportError } from "../output";
import { type Arranged, arrangeSimWindows } from "../sim-windows";

/** Tile open Simulator.app windows of warden sims in name order (Device Hub, Xcode 27: not tiled yet). */
async function arrange(ctx: CommandContext, json: boolean): Promise<number> {
	const result = await arrangeSimWindows(ctx.exec);
	if (!result.success) {
		reportError(ctx, "arrange", result.error);
		return 1;
	}
	const { arranged, viewer } = result.data;
	emit(ctx, json, { arranged, viewer }, arrangeText(ctx, result.data));
	return 0;
}

function arrangeText(ctx: CommandContext, { arranged, viewer }: Arranged): string {
	const { color } = ctx.ui;
	if (viewer === "device-hub") return color.dim("Device Hub (Xcode 27) windows are not tiled yet: nothing arranged");
	return arranged.length === 0 ? color.dim("no warden simulator windows open") : `arranged ${arranged.join(", ")}`;
}

export const arrangeCommand = defineCommand({
	name: "arrange",
	group: "Devices",
	summary: "tile warden simulator windows in name order (macOS; also runs after iOS claims)",
	register: (cmd, ctx, done) => {
		cmd
			.option("--json", "machine-readable output")
			.action(async (opts) => done(await arrange(ctx, opts.json === true)));
	},
});
