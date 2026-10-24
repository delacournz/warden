import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, reportError } from "../output";
import { type Arranged, arrangeSimWindows, reopenSimWindows } from "../sim-windows";

/** Tile open Simulator.app (Xcode ≤ 26) / Device Hub (Xcode 27) windows of warden sims in name order. */
async function arrange(ctx: CommandContext, json: boolean, open: readonly string[]): Promise<number> {
	if (open.length > 0) {
		const opened = await reopenSimWindows(ctx, open);
		emit(ctx, json, { opened }, opened.length === 0 ? "no windows opened" : `opened ${opened.join(", ")}`);
		return 0;
	}
	const result = await arrangeSimWindows(ctx.exec);
	if (!result.success) {
		reportError(ctx, "arrange", result.error);
		return 1;
	}
	const { arranged, viewer } = result.data;
	emit(ctx, json, { arranged, viewer }, arrangeText(ctx, result.data));
	return 0;
}

function arrangeText(ctx: CommandContext, { arranged }: Arranged): string {
	const { color } = ctx.ui;
	return arranged.length === 0 ? color.dim("no warden simulator windows open") : `arranged ${arranged.join(", ")}`;
}

export const arrangeCommand = defineCommand({
	name: "arrange",
	group: "Devices",
	summary: "tile warden simulator windows in name order (macOS; also runs after iOS claims)",
	register: (cmd, ctx, done) => {
		cmd
			.option(
				"--open <udid...>",
				"first ask Device Hub for these sims' windows (Xcode 27, only while it runs), then tile"
			)
			.option("--json", "machine-readable output")
			.action(async (opts) => done(await arrange(ctx, opts.json === true, opts.open ?? [])));
	},
});
