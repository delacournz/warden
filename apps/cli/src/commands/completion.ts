import { Argument } from "@commander-js/extra-typings";
import { defineCommand } from "../command";
import { COMPLETION_SHELLS, type CompletionShell, completionScript, shellFromEnv } from "../completion-scripts";
import type { CommandContext } from "../context";
import { reportError } from "../output";

function runCompletion(ctx: CommandContext, shell: CompletionShell | undefined): number {
	const target = shell ?? shellFromEnv(ctx.env);
	if (!target) {
		reportError(ctx, "completion", `can't tell your shell from $SHELL — name it: ${COMPLETION_SHELLS.join(" | ")}`);
		return 1;
	}
	ctx.out(completionScript(target).replace(/\n$/, ""));
	return 0;
}

export const completionCommand = defineCommand({
	name: "completion",
	group: "Setup",
	summary: "print the tab-completion script for zsh / bash / fish (`warden install` sets it up)",
	register: (cmd, ctx, done) => {
		cmd
			.addArgument(new Argument("[shell]", "default: $SHELL").choices(COMPLETION_SHELLS))
			.addHelpText(
				"after",
				"\nLoad it in your shell:\n  zsh   source <(warden completion zsh)\n  bash  source <(warden completion bash)\n  fish  warden completion fish | source"
			)
			.action((shell) => done(runCompletion(ctx, shell)));
	},
});
