import { join } from "node:path";
import { collectRunnerSources, loadEmbeddedRunnerSources } from "@delacour/warden-core/ios-runner/pack";
import type { RunnerSourceFiles } from "@delacour/warden-core/ios-runner/runner-build.types";
import type { AsyncResult } from "@delacour/warden-types/result";
import { type BuildInfo, currentBuild } from "../update/build-info";

/**
 * The iOS runner's Xcode project as text files: read from the checkout when warden runs from source, from the blob
 * embedded in the compiled binary otherwise. Feeds the iPhone runner build and the simulator's XCUITest audit.
 */
export function runnerSourcesFor(info: BuildInfo = currentBuild()): () => AsyncResult<RunnerSourceFiles> {
	return async () =>
		info.channel === "dev"
			? collectRunnerSources(join(info.sourceDir, "packages", "e2e", "native"))
			: loadEmbeddedRunnerSources();
}
