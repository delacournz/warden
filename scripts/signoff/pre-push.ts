#!/usr/bin/env bun
import { gitCommonDir, turboCacheEnv } from "./signoff";
/**
 * The pre-push hook (`.pre-commit-config.yaml`): the always-on signoff checks, before anything leaves the machine.
 *
 * Same turbo tasks as `bun run signoff` (derived from `SIGNOFF_CHECKS`, so the two cannot drift) and the same
 * shared turbo cache (`turboCacheEnv`), so the signoff that follows the push replays these results instead of
 * running them a second time. Path-gated checks (`native`, `cpu-guard`) stay with signoff: they need the PR's
 * diff base, which a push does not have.
 */
import { SIGNOFF_CHECKS, type SignoffCheck } from "./signoff-checks";

/** One `turbo run` over every always-on check's task. Throws on an always-on check that is not a turbo task. */
export function prePushArgv(checks: readonly SignoffCheck[]): string[] {
	const tasks = checks
		.filter((check) => check.always)
		.map((check) => {
			const argv = check.run.length === 1 ? check.run[0]?.argv : undefined;
			const task = argv?.[0] === "bunx" && argv[1] === "turbo" && argv.length === 3 ? argv[2] : undefined;
			if (task === undefined)
				throw new Error(`always-on check ${check.context} is not one turbo task; teach pre-push.ts to run it`);
			return task;
		});
	return ["bunx", "turbo", "run", ...tasks];
}

if (import.meta.main) {
	const env = turboCacheEnv(process.env, await gitCommonDir());
	const child = Bun.spawn(prePushArgv(SIGNOFF_CHECKS), {
		cwd: `${import.meta.dir}/../..`,
		env,
		stdio: ["inherit", "inherit", "inherit"],
	});
	process.exit(await child.exited);
}
