import { dirname } from "node:path";
import cliPackage from "../../package.json" with { type: "json" };

/**
 * Where this warden came from:
 * - `dev`: running from source (`bun apps/cli/src/cli.ts`)
 * - `local`: compiled from a checkout (`sourceDir`), updated by rebuilding it
 * - `release`: a GitHub release binary, updated by downloading the latest release
 */
export type BuildInfo =
	| { channel: "dev"; version: string; sourceDir: string }
	| { channel: "local"; version: string; sourceDir?: string; commit?: string; builtAt?: string }
	| { channel: "release"; version: string; commit?: string; builtAt?: string };

/** Embedded at compile time via `--define __WARDEN_BUILD__=<json>` (see `update/source-build.ts`). */
declare const __WARDEN_BUILD__: BuildInfo | undefined;

export const DEFINE_KEY = "__WARDEN_BUILD__";

export class BuildInfoHelpers {
	/** `<root>/apps/cli/src/cli.ts` → `<root>`. */
	sourceDirFromCliPath(cliPath: string): string {
		return dirname(dirname(dirname(dirname(cliPath))));
	}

	private isCompiled(main: string): boolean {
		return main.startsWith("/$bunfs/") || main.startsWith("B:/~BUN/");
	}

	resolveBuildInfo(embedded: BuildInfo | undefined, main: string, packageVersion: string): BuildInfo {
		if (!this.isCompiled(main))
			return { channel: "dev", version: packageVersion, sourceDir: this.sourceDirFromCliPath(main) };
		return embedded ?? { channel: "local", version: packageVersion };
	}

	currentBuild(): BuildInfo {
		const embedded = typeof __WARDEN_BUILD__ === "undefined" ? undefined : __WARDEN_BUILD__;
		return this.resolveBuildInfo(embedded, Bun.main, cliPackage.version);
	}

	/** `0.2.0 (local abc1234, /repo)`. */
	describeBuild(build: BuildInfo): string {
		switch (build.channel) {
			case "dev":
				return `${build.version} (dev, ${build.sourceDir})`;
			case "local": {
				const parts = [build.commit ? `local ${build.commit}` : "local", build.sourceDir].filter(Boolean);
				return `${build.version} (${parts.join(", ")})`;
			}
			case "release":
				return `${build.version} (release${build.commit ? ` ${build.commit}` : ""})`;
		}
	}
}

export const buildInfoHelpers = new BuildInfoHelpers();
