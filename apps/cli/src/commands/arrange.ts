import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit } from "../output";
import { arrangeSimWindows } from "../sim-windows";

/** Tile open Simulator.app windows of warden sims in name order. */
async function arrange(ctx: CommandContext, json: boolean): Promise<number> {
	const { color } = ctx.ui;
	const result = await arrangeSimWindows(ctx.exec);
	if (!result.success) {
		ctx.err(color.red(`warden arrange: ${result.error}`));
		return 1;
	}
	const { arranged } = result.data;
	const text =
		arranged.length === 0 ? color.dim("no warden simulator windows open") : `arranged ${arranged.join(", ")}`;
	emit(ctx, json, { arranged }, text);
	return 0;
}

export const arrangeCommand = defineCommand({
	name: "arrange",
	summary: "tile warden simulator windows in name order (macOS; also runs after iOS claims)",
	register: (cmd, ctx, done) => {
		cmd
			.option("--json", "machine-readable output")
			.action(async (opts) => done(await arrange(ctx, opts.json === true)));
	},
});
