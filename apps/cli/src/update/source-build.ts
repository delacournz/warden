import { join } from "node:path";
import type { Exec } from "@delacour/warden-core/exec";
import { execError } from "@delacour/warden-core/exec";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { type BuildInfo, DEFINE_KEY } from "./build-info";

export type EmbeddedBuild = Exclude<BuildInfo, { channel: "dev" }>;

/** What `bun build --compile` writes next to the outfile when a source map is requested (the map is also embedded). */
export const STRAY_SOURCE_MAP = "cli.js.map";

/**
 * `bun build --compile` argv that embeds `info` (read back by `currentBuild()`).
 *
 * `--minify --bytecode` take a cold `warden version` from ~120 ms to ~27 ms: the plain binary re-parses the whole
 * 10 MB bundle (typescript included) on every start, bytecode skips that. `--sourcemap=linked` is what keeps stack
 * traces and uncaught-error excerpts readable (otherwise a minified one-line bundle is printed); the map is embedded
 * in the binary and `STRAY_SOURCE_MAP` is left beside it. Constraints: bytecode is CommonJS, so no top-level `await`
 * in anything bundled (`cli.ts` uses `.then`).
 */
export function compileArgs(opts: { entry: string; outfile: string; info: EmbeddedBuild; target?: string }): string[] {
	return [
		"bun",
		"build",
		"--compile",
		"--minify",
		"--bytecode",
		"--sourcemap=linked",
		opts.entry,
		"--outfile",
		opts.outfile,
		...(opts.target ? [`--target=${opts.target}`] : []),
		"--define",
		`${DEFINE_KEY}=${JSON.stringify(opts.info)}`,
	];
}

export function cliDir(sourceDir: string): string {
	return join(sourceDir, "apps", "cli");
}

/** Short HEAD sha of `sourceDir`, `-dirty` when the tree has uncommitted changes. */
export async function sourceCommit(exec: Exec, sourceDir: string): Promise<string | undefined> {
	const head = await exec(["git", "-C", sourceDir, "rev-parse", "--short", "HEAD"]);
	if (head.exitCode !== 0) return undefined;
	const status = await exec(["git", "-C", sourceDir, "status", "--porcelain"]);
	return `${head.stdout.trim()}${status.stdout.trim() ? "-dirty" : ""}`;
}

/** Compile a `local` warden from the checkout at `sourceDir` into `outfile`. */
export async function buildFromSource(
	exec: Exec,
	sourceDir: string,
	version: string,
	outfile: string,
	now: () => number
): AsyncResult<EmbeddedBuild> {
	const commit = await sourceCommit(exec, sourceDir);
	const info: EmbeddedBuild = {
		channel: "local",
		version,
		sourceDir,
		...(commit ? { commit } : {}),
		builtAt: new Date(now()).toISOString(),
	};
	const cmd = compileArgs({ entry: join(cliDir(sourceDir), "src", "cli.ts"), outfile, info });
	const result = await exec(cmd, { cwd: cliDir(sourceDir) });
	return result.exitCode === 0 ? ok(info) : err(execError(cmd, result));
}
