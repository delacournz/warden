import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import type { RunnerSourceFiles } from "./runner-build.types";

/**
 * The iPhone runner's Xcode project, as the text files the binary embeds (`ios-runner.bin`: a JSON map of
 * path -> text), the way the `@delacour/warden-e2e` runtime is. Paths are relative to `packages/e2e/native`
 * and keep that layout, because the project reaches the shared `warden-simd` files through `../ios/…`.
 */

/** Name of the embedded blob (`Bun.embeddedFiles` reports it with a content hash: `ios-runner-<hash>.bin`). */
export const RUNNER_BLOB = "ios-runner.bin";

/** `packages/e2e/native/ios-runner` pieces the build needs (no SwiftPM tests, no docs, no spec). */
const RUNNER_DIRS = ["ios-runner/Host", "ios-runner/RunnerTests", "ios-runner/WardenRunner.xcodeproj"] as const;
/** RunnerCore's sources, minus `Shared/` (symlinks to the files below, which the project lists on their own). */
const RUNNER_CORE = "ios-runner/RunnerCore/Sources/RunnerCore";
const SHARED_DIR = `${RUNNER_CORE}/Shared`;
/** The `warden-simd` files `project.yml` compiles into the runner. */
const SIMD_FILES = [
	"ios/Sources/warden-simd/Protocol/Wire.swift",
	"ios/Sources/warden-simd/Protocol/NDJSON.swift",
	"ios/Sources/warden-simd/Model/Element.swift",
	"ios/Sources/warden-simd/Model/RoleMap.swift",
] as const;

const SKIPPED = new Set(["xcuserdata", ".build", ".DS_Store", "build"]);

function walk(root: string, rel: string, out: Record<string, string>): void {
	if (rel === SHARED_DIR) return;
	for (const name of readdirSync(join(root, rel)).sort()) {
		if (SKIPPED.has(name)) continue;
		const path = `${rel}/${name}`;
		const stat = lstatSync(join(root, path));
		if (stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) walk(root, path, out);
		else out[path] = readFileSync(join(root, path), "utf8");
	}
}

/** Read the runner sources from a checkout's `packages/e2e/native` directory. */
export function collectRunnerSources(nativeDir: string): Result<RunnerSourceFiles> {
	try {
		const files: Record<string, string> = {};
		for (const dir of [...RUNNER_DIRS, RUNNER_CORE]) walk(nativeDir, dir, files);
		for (const file of SIMD_FILES) files[file] = readFileSync(join(nativeDir, file), "utf8");
		return ok(files);
	} catch (cause) {
		return err(`cannot read the iOS runner sources in ${nativeDir}: ${String(cause)}`);
	}
}

export function writeRunnerBlob(nativeDir: string, outFile: string): Result<void> {
	const files = collectRunnerSources(nativeDir);
	if (!files.success) return files;
	writeFileSync(outFile, JSON.stringify(files.data));
	return ok(undefined);
}

/** A path inside the staged root: relative, `/`-separated, no `..`. */
export function isSafeSourcePath(path: string): boolean {
	return (
		path !== "" &&
		!path.startsWith("/") &&
		!path.includes("\\") &&
		!path.split("/").some((p) => p === ".." || p === "" || p === ".")
	);
}

export function parseRunnerBlob(text: string): Result<RunnerSourceFiles> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return err("embedded iOS runner sources are not valid JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		return err("embedded iOS runner sources are not an object");
	const files: Record<string, string> = {};
	for (const [path, content] of Object.entries(parsed)) {
		if (typeof content !== "string") return err(`embedded iOS runner sources: ${path} is not text`);
		if (!isSafeSourcePath(path)) return err(`embedded iOS runner sources: bad path ${JSON.stringify(path)}`);
		files[path] = content;
	}
	return ok(files);
}

/** The blob embedded in the compiled binary (`Bun.embeddedFiles`, name `ios-runner-<hash>.bin`). */
export async function loadEmbeddedRunnerSources(
	embedded: readonly Blob[] = Bun.embeddedFiles
): AsyncResult<RunnerSourceFiles> {
	const blob = embedded.find(
		(file) => "name" in file && typeof file.name === "string" && /^ios-runner(-[^.]*)?\.bin$/.test(file.name)
	);
	if (blob === undefined) return err("this warden build has no embedded iOS runner sources; rebuild it");
	return parseRunnerBlob(await blob.text());
}
