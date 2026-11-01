import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_BUILD_COMMAND } from "../builds.defaults";
import type { Project } from "../config";

/** Fixtures for builds tests: a resolved project and a fake `.app`. Use the `buildsTesting` singleton. */
export class BuildsTesting {
	/** A resolved project for tests (root `/repo/app`, both bundle ids). */
	project(overrides: Partial<Project> = {}): Project {
		return {
			name: "app",
			root: "/repo/app",
			bundleId: { ios: "com.x.app", android: "com.x.app" },
			framework: "expo",
			build: { ...DEFAULT_BUILD_COMMAND },
			buildConfiguration: "Debug",
			cacheDirs: [],
			origin: "config",
			source: "repo",
			...overrides,
		};
	}

	/** A fake `.app` bundle dir (12 bytes) under `parent`. */
	fakeApp(parent: string, name = "App.app"): string {
		const app = join(parent, name);
		mkdirSync(app, { recursive: true });
		writeFileSync(join(app, "Info.plist"), "plist");
		writeFileSync(join(app, "App"), "binary!");
		return app;
	}
}

export const buildsTesting = new BuildsTesting();
