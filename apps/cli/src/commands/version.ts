import type { Command } from "../context";
import { emit } from "../output";
import { currentBuild, describeBuild } from "../update/build-info";

export const versionCommand: Command = {
	name: "version",
	summary: "print warden's version and build channel (dev / local / release)",
	usage: "warden version [--json]",
	run: async (ctx) => {
		const build = currentBuild();
		emit(ctx, ctx.argv.includes("--json"), build, `warden ${describeBuild(build)}`);
		return 0;
	},
};
