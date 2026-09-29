import { defineCommand } from "../command";
import { emit } from "../output";
import { currentBuild, describeBuild } from "../update/build-info";

export const versionCommand = defineCommand({
	name: "version",
	summary: "print warden's version and build channel (dev / local / release)",
	register: (cmd, ctx, done) => {
		cmd.option("--json", "machine-readable output").action((opts) => {
			const build = currentBuild();
			emit(ctx, opts.json === true, build, `warden ${ctx.ui.color.bold(describeBuild(build))}`);
			done(0);
		});
	},
});
