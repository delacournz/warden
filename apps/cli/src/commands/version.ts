import { CliCommand, type CommandNode } from "../command";
import type { CommandContext } from "../context";
import { output } from "../output";
import { buildInfoHelpers } from "../update/build-info";

export class VersionCommand extends CliCommand {
	override readonly name = "version";
	override readonly group = "Setup";
	override readonly summary = "print warden's version and build channel (dev / local / release)";

	protected register(cmd: CommandNode, ctx: CommandContext, done: (code: number) => void): void {
		cmd.option("--json", "machine-readable output").action((opts) => {
			const build = buildInfoHelpers.currentBuild();
			output.emit(ctx, opts.json === true, build, `warden ${ctx.ui.color.bold(buildInfoHelpers.describeBuild(build))}`);
			done(0);
		});
	}
}

export const versionCommand = new VersionCommand().definition();
