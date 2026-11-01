import { type Arranged, SimWindowArranger } from "@delacour/warden-leasing/sim-windows";
import { CliCommand, type CommandNode } from "../command";
import type { CommandContext } from "../context";
import { output } from "../output";

export class ArrangeCommand extends CliCommand {
	override readonly name = "arrange";
	override readonly group = "Devices";
	override readonly summary = "tile warden simulator windows in name order (macOS; also runs after iOS claims)";

	protected register(cmd: CommandNode, ctx: CommandContext, done: (code: number) => void): void {
		cmd
			.option(
				"--open <udid...>",
				"first ask Device Hub for these sims' windows (Xcode 27, only while it runs), then tile"
			)
			.option("--json", "machine-readable output")
			.action(async (opts) => done(await this.arrange(ctx, opts.json === true, opts.open ?? [])));
	}

	/** Tile open Simulator.app (Xcode ≤ 26) / Device Hub (Xcode 27) windows of warden sims in name order. */
	private async arrange(ctx: CommandContext, json: boolean, open: readonly string[]): Promise<number> {
		if ((ctx.os ?? process.platform) !== "darwin") {
			output.emit(
				ctx,
				json,
				open.length > 0 ? { opened: [] } : { arranged: [], viewer: "none" },
				ctx.ui.color.dim("macOS only: nothing to do")
			);
			return 0;
		}
		if (open.length > 0) {
			const opened = await new SimWindowArranger(ctx).reopen(open);
			output.emit(ctx, json, { opened }, opened.length === 0 ? "no windows opened" : `opened ${opened.join(", ")}`);
			return 0;
		}
		const result = await new SimWindowArranger({ exec: ctx.exec }).arrange();
		if (!result.success) {
			output.reportError(ctx, "arrange", result.error);
			return 1;
		}
		const { arranged, viewer } = result.data;
		output.emit(ctx, json, { arranged, viewer }, this.arrangeText(ctx, result.data));
		return 0;
	}

	private arrangeText(ctx: CommandContext, { arranged }: Arranged): string {
		const { color } = ctx.ui;
		return arranged.length === 0 ? color.dim("no warden simulator windows open") : `arranged ${arranged.join(", ")}`;
	}
}

export const arrangeCommand = new ArrangeCommand().definition();
