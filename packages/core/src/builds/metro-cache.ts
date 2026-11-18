import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { wardenHome } from "../store";
import type { Platform } from "../types";
import { METRO_CACHE_DIR_NAME, METRO_CACHE_MAX_IDLE_MS } from "./builds.defaults";
import { bundleEnvLines } from "./js-key";
import { safeKey } from "./project-key";

/** Salt of the hashed text: bump it to start every Metro cache afresh. */
const KEY_FORMAT = "warden metro-cache v1";

export type MetroCacheDirInput = {
	/** the bundle step's env: `EXPO_PUBLIC_*` / `NODE_ENV` of it split the cache; `WARDEN_HOME` places it */
	env: Record<string, string | undefined>;
	/** `kinds.<kind>.env`: any name counts, as in the JS key */
	kindEnv?: Record<string, string>;
	projectKey: string;
	platform: Platform;
	/** the bundler flags (`bundlerFlags`) */
	flags: readonly string[];
};

/**
 * The persistent Metro cache of a project's repack bundles: `$WARDEN_HOME/metro-cache/<safe projectKey>/<platform>-<h>`,
 * `h` a hash of the bundle env and the bundler flags. Metro keys its transforms on file content and transformer config,
 * not on env values Babel inlines (`EXPO_PUBLIC_*`), so another env value gets its own cache rather than a stale one.
 */
export function metroCacheDir(input: MetroCacheDirInput): string {
	const text = [
		KEY_FORMAT,
		`env:${bundleEnvLines(input.env, input.kindEnv).join("\0")}`,
		`flags:${input.flags.join("\0")}`,
	].join("\n");
	const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
	return join(wardenHome(input.env), METRO_CACHE_DIR_NAME, safeKey(input.projectKey), `${input.platform}-${hash}`);
}

export type PrepareMetroCacheOptions = {
	now: number;
	/** empty it first (`warden repack --force`) */
	reset?: boolean;
	/** default `METRO_CACHE_MAX_IDLE_MS` */
	maxIdleMs?: number;
};

/**
 * Ready `dir` for a bundle and return it as the bundler's `TMPDIR` (`<dir>/`): Metro's file cache (`metro-cache`) and
 * its file map live under `os.tmpdir()`, for Expo and the community CLI alike. Marks `dir` used and deletes the
 * project's other caches no bundle used within `maxIdleMs`. Best effort: a prune that fails is skipped.
 */
export function prepareMetroCache(dir: string, options: PrepareMetroCacheOptions): string {
	if (options.reset) rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const now = new Date(options.now);
	utimesSync(dir, now, now);
	pruneIdle(dirname(dir), dir, options.now - (options.maxIdleMs ?? METRO_CACHE_MAX_IDLE_MS));
	return `${dir}/`;
}

/** Delete the dirs in `parent` (but `keep`) last used before `before`. */
function pruneIdle(parent: string, keep: string, before: number): void {
	let names: string[];
	try {
		names = readdirSync(parent);
	} catch {
		return;
	}
	for (const name of names) {
		const path = join(parent, name);
		if (path === keep) continue;
		try {
			if (statSync(path).mtimeMs < before) rmSync(path, { recursive: true, force: true });
		} catch {
			// another bundle may be using or removing it: leave it
		}
	}
}
