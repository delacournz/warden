import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { RUNNER_BLOB } from "@delacour/warden-builds/ios-runner/pack";
import { type Exec, execErrors } from "@delacour/warden-runtime/exec";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
import { RUNTIME_BLOB } from "../e2e/e2e-runtime";
import { type BuildInfo, DEFINE_KEY } from "./build-info";

export type EmbeddedBuild = Exclude<BuildInfo, { channel: "dev" }>;

/** What `bun build --compile` writes next to the outfile when a source map is requested (the map is also embedded). */
export const STRAY_SOURCE_MAP = "cli.js.map";

export class SourceBuild {
	/**
	 * `bun build --compile` argv that embeds `info` (read back by `currentBuild()`).
	 *
	 * `--minify --bytecode` take a cold `warden version` from ~120 ms to ~27 ms: the plain binary re-parses the whole
	 * 10 MB bundle (typescript included) on every start, bytecode skips that. `--sourcemap=linked` is what keeps stack
	 * traces and uncaught-error excerpts readable (otherwise a minified one-line bundle is printed); the map is embedded
	 * in the binary and `STRAY_SOURCE_MAP` is left beside it. Constraints: bytecode is CommonJS, so no top-level `await`
	 * in anything bundled (`cli.ts` uses `.then`). `--external typescript`: the compiler is 28 MB of the bundle (a quarter
	 * of the binary) for `warden affected`'s graph walk only, which loads the analysed project's own (`typescriptResolver.resolve`).
	 */
	compileArgs(opts: {
		entry: string;
		outfile: string;
		info: EmbeddedBuild;
		target?: string;
		/** extra files to embed (`Bun.embeddedFiles`), e.g. the `@delacour/warden-e2e` runtime blob */
		embed?: readonly string[];
	}): string[] {
		return [
			"bun",
			"build",
			"--compile",
			"--minify",
			"--bytecode",
			"--sourcemap=linked",
			"--external",
			"typescript",
			opts.entry,
			...(opts.embed ?? []),
			"--outfile",
			opts.outfile,
			...(opts.target ? [`--target=${opts.target}`] : []),
			"--define",
			`${DEFINE_KEY}=${JSON.stringify(opts.info)}`,
		];
	}

	/** `bun <apps/cli/scripts/e2e-runtime.ts> <repoRoot> <blob> <version>`: writes the runtime blob the binary embeds. */
	runtimeBlobArgs(sourceDir: string, blob: string, version: string): string[] {
		return ["bun", join(this.cliDir(sourceDir), "scripts", "e2e-runtime.ts"), sourceDir, blob, version];
	}

	/** `bun <apps/cli/scripts/ios-runner-blob.ts> <repoRoot> <blob>`: writes the iPhone runner sources the binary embeds. */
	runnerBlobArgs(sourceDir: string, blob: string): string[] {
		return ["bun", join(this.cliDir(sourceDir), "scripts", "ios-runner-blob.ts"), sourceDir, blob];
	}

	cliDir(sourceDir: string): string {
		return join(sourceDir, "apps", "cli");
	}

	/** Short HEAD sha of `sourceDir`, `-dirty` when the tree has uncommitted changes. */
	async sourceCommit(exec: Exec, sourceDir: string): Promise<string | undefined> {
		const head = await exec(["git", "-C", sourceDir, "rev-parse", "--short", "HEAD"]);
		if (head.exitCode !== 0) return undefined;
		const status = await exec(["git", "-C", sourceDir, "status", "--porcelain"]);
		return `${head.stdout.trim()}${status.stdout.trim() ? "-dirty" : ""}`;
	}

	/** Compile a `local` warden from the checkout at `sourceDir` into `outfile`. */
	async buildFromSource(
		exec: Exec,
		sourceDir: string,
		version: string,
		outfile: string,
		now: () => number
	): AsyncResult<EmbeddedBuild> {
		const commit = await this.sourceCommit(exec, sourceDir);
		const info: EmbeddedBuild = {
			channel: "local",
			version,
			sourceDir,
			...(commit ? { commit } : {}),
			builtAt: new Date(now()).toISOString(),
		};
		// the blob's name is what `Bun.embeddedFiles` reports (plus a hash), so it must be called RUNTIME_BLOB
		const blob = join(dirname(outfile), RUNTIME_BLOB);
		const runnerBlob = join(dirname(outfile), RUNNER_BLOB);
		try {
			for (const pack of [this.runtimeBlobArgs(sourceDir, blob, version), this.runnerBlobArgs(sourceDir, runnerBlob)]) {
				const packed = await exec(pack, { cwd: this.cliDir(sourceDir) });
				if (packed.exitCode !== 0) return resultFactory.err(execErrors.format(pack, packed));
			}
			const embed = [blob, runnerBlob];
			const cmd = this.compileArgs({ entry: join(this.cliDir(sourceDir), "src", "cli.ts"), outfile, info, embed });
			const result = await exec(cmd, { cwd: this.cliDir(sourceDir) });
			return result.exitCode === 0 ? resultFactory.ok(info) : resultFactory.err(execErrors.format(cmd, result));
		} finally {
			rmSync(blob, { force: true });
			rmSync(runnerBlob, { force: true });
		}
	}
}

export const sourceBuild = new SourceBuild();
