#!/usr/bin/env bun
import { $ } from "bun";

async function main() {
	const stagedFilesResult = await $`git diff --cached --name-only --diff-filter=ACM`.text();
	const stagedFiles = stagedFilesResult
		.trim()
		.split("\n")
		.filter((f) => f.match(/\.(js|jsx|ts|tsx|json|jsonc|css|scss|md|mdx)$/));

	if (stagedFiles.length === 0) {
		console.log("No staged files to check");
		process.exit(0);
	}

	console.log(`Checking ${stagedFiles.length} staged files with biome...`);

	const biomeResult = await $`bun x biome check --write --no-errors-on-unmatched ${stagedFiles}`.quiet().nothrow();

	for (const file of stagedFiles) {
		const diffResult = await $`git diff --name-only -- ${file}`.quiet().text();
		if (diffResult.trim()) {
			console.log(`Re-staging fixed file: ${file}`);
			await $`git add ${file}`.quiet();
		}
	}

	if (biomeResult.exitCode !== 0) {
		const recheckResult = await $`bun x biome check --no-errors-on-unmatched ${stagedFiles}`.quiet().nothrow();
		process.exit(recheckResult.exitCode);
	}

	process.exit(0);
}

main().catch((error) => {
	console.error("Pre-commit biome check failed:", error);
	process.exit(1);
});
