import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { isSafeSourcePath } from "./pack";
import type { RunnerSourceFiles } from "./runner-build.types";

const READY_MARKER = ".ready";

export type StagedRunner = {
	/** `<home>/ios-runner/src/<version>-<hash>` */
	dir: string;
	/** the Xcode project inside it */
	project: string;
	/** `<version>-<hash>`: part of the build cache key */
	key: string;
	/** first 10 hex digits of the sources' hash */
	hash: string;
};

/** Where the runner builds live: `<home>/ios-runner`. */
export function runnerRoot(home: string): string {
	return join(home, "ios-runner");
}

/** Content hash of the sources: names and texts, in name order. */
export function runnerSourceHash(files: RunnerSourceFiles): string {
	const hash = createHash("sha256");
	for (const name of Object.keys(files).sort())
		hash
			.update(name)
			.update("\0")
			.update(files[name] ?? "")
			.update("\0");
	return hash.digest("hex").slice(0, 10);
}

/**
 * Write the runner sources to `<home>/ios-runner/src/<version>-<hash>/` (the layout of `packages/e2e/native`).
 * Content-keyed and never rewritten in place, so a build still running from an older copy is safe. Written to a
 * sibling temp directory and renamed, so a concurrent warden never sees half a copy; `.ready` marks a complete one.
 */
export async function stageRunnerSources(o: {
	home: string;
	version: string;
	loadSources: () => AsyncResult<RunnerSourceFiles>;
}): AsyncResult<StagedRunner> {
	const loaded = await o.loadSources();
	if (!loaded.success) return loaded;
	const files = loaded.data;
	const project = "ios-runner/WardenRunner.xcodeproj/project.pbxproj";
	if (!(project in files)) return err(`the iOS runner sources lack ${project}`);
	for (const name of Object.keys(files)) {
		if (!isSafeSourcePath(name)) return err(`the iOS runner sources have a bad path ${JSON.stringify(name)}`);
	}
	const hash = runnerSourceHash(files);
	const key = `${o.version}-${hash}`;
	const dir = join(runnerRoot(o.home), "src", key);
	const staged: StagedRunner = { dir, project: join(dir, "ios-runner", "WardenRunner.xcodeproj"), key, hash };
	if (existsSync(join(dir, READY_MARKER))) return ok(staged);
	const tmp = `${dir}.tmp-${process.pid}`;
	try {
		rmSync(tmp, { recursive: true, force: true });
		for (const [name, content] of Object.entries(files)) {
			const target = join(tmp, name);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, content);
		}
		writeFileSync(join(tmp, READY_MARKER), `${o.version}\n`);
		// a half-written copy from a crashed run has no marker: replace it
		rmSync(dir, { recursive: true, force: true });
		try {
			renameSync(tmp, dir);
		} catch (cause) {
			// another warden renamed its copy in first: same key, same content
			if (!existsSync(join(dir, READY_MARKER))) throw cause;
		}
		return ok(staged);
	} catch (cause) {
		return err(`could not stage the iOS runner sources to ${dir}: ${String(cause)}`);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}
