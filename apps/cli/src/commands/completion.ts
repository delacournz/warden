import { Argument } from "@commander-js/extra-typings";
import { CliCommand, type CommandNode } from "../command";
import { COMPLETION_SHELLS, type CompletionShell, completionScript, shellFromEnv } from "../completion-scripts";
import type { CommandContext } from "../context";
import { output } from "../output";

export class CompletionCommand extends CliCommand {
	override readonly name = "completion";
	override readonly group = "Setup";
	override readonly summary = "print the tab-completion script for zsh / bash / fish (`warden install` sets it up)";

	protected register(cmd: CommandNode, ctx: CommandContext, done: (code: number) => void): void {
		cmd
			.addArgument(new Argument("[shell]", "default: $SHELL").choices(COMPLETION_SHELLS))
			.addHelpText(
				"after",
				"\nLoad it in your shell:\n  zsh   source <(warden completion zsh)\n  bash  source <(warden completion bash)\n  fish  warden completion fish | source"
			)
			.action((shell) => done(this.runCompletion(ctx, shell)));
	}

	private runCompletion(ctx: CommandContext, shell: CompletionShell | undefined): number {
		const target = shell ?? shellFromEnv(ctx.env);
		if (!target) {
			output.reportError(
				ctx,
				"completion",
				`can't tell your shell from $SHELL — name it: ${COMPLETION_SHELLS.join(" | ")}`
			);
			return 1;
		}
		ctx.out(completionScript(target).replace(/\n$/, ""));
		return 0;
	}
}

export const completionCommand = new CompletionCommand().definition();
