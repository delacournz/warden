import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_BUILD_COMMAND } from "./builds.defaults";
import type { Project } from "./config";

/** A resolved project for tests (root `/repo/app`, both bundle ids). */
export function testProject(overrides: Partial<Project> = {}): Project {
	return {
		name: "app",
		root: "/repo/app",
		bundleId: { ios: "com.x.app", android: "com.x.app" },
		build: { ...DEFAULT_BUILD_COMMAND },
		cacheDirs: [],
		origin: "config",
		...overrides,
	};
}

/** A fake `.app` bundle dir (12 bytes) under `parent`. */
export function fakeApp(parent: string, name = "App.app"): string {
	const app = join(parent, name);
	mkdirSync(app, { recursive: true });
	writeFileSync(join(app, "Info.plist"), "plist");
	writeFileSync(join(app, "App"), "binary!");
	return app;
}
