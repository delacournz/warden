import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { wardenHome } from "../store";
import type { Platform } from "../types";
import { METRO_CACHE_DIR_NAME, METRO_CACHE_MAX_AGE_MS, METRO_CACHE_MAX_IDLE_MS } from "./builds.defaults";
import { bundleEnvLines, envFileLines } from "./js-key";
import { safeKey } from "./project-key";

/** Salt of the hashed text: bump it to start every Metro cache afresh. */
const KEY_FORMAT = "warden metro-cache v1";

/** Metro's FileStore under `TMPDIR` (`os.tmpdir()/metro-cache`). */
const STORE = "metro-cache";

/** When this cache dir was started afresh (epoch ms): `prepareMetroCache` resets it past `maxAgeMs`. */
const CREATED = ".warden-created";

export type MetroCacheDirInput = {
	/** the bundle step's env: `EXPO_PUBLIC_*` / `NODE_ENV` of it split the cache; `WARDEN_HOME` places it */
	env: Record<string, string | undefined>;
	/** `kinds.<kind>.env`: any name counts, as in the JS key */
	kindEnv?: Record<string, string>;
	/** the project root: its `.env*` files split the cache too */
	root?: string;
	projectKey: string;
	platform: Platform;
	/** the bundler flags (`bundlerFlags`) */
	flags: readonly string[];
};

/**
 * The persistent Metro cache of a project's repack bundles: `$WARDEN_HOME/metro-cache/<safe projectKey>/<platform>-<h>`,
 * `h` a hash of the bundle env, the project's `.env*` files and the bundler flags. Metro keys its transforms on file
 * content and transformer config, not on env values Babel inlines (`EXPO_PUBLIC_*`), so another env value gets its own
 * cache rather than a stale one.
 */
export function metroCacheDir(input: MetroCacheDirInput): string {
	const text = [
		KEY_FORMAT,
		`env:${bundleEnvLines(input.env, input.kindEnv).join("\0")}`,
		`env-files:${envFileLines(input.root).join("\0\0")}`,
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
	/** default `METRO_CACHE_MAX_AGE_MS` */
	maxAgeMs?: number;
};

export type MetroCache = {
	/** the bundler's `TMPDIR` (`<dir>/`) */
	tmpdir: string;
	/** Metro's FileStore root in it: Expo's `EXPO_METRO_CACHE_OUTPUT_DIR` */
	storeDir: string;
	/**
	 * Bundle with `--reset-cache`: Metro has not written its store here yet. Free on an empty dir, and a project whose
	 * own `cacheStores` live elsewhere (never here) keeps the reset every bundle, as before warden kept a cache.
	 */
	resetCache: boolean;
};

function createdAt(dir: string): number | undefined {
	try {
		const value = Number(readFileSync(join(dir, CREATED), "utf8").trim());
		return Number.isFinite(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Ready `dir` for a bundle: Metro's file cache and file map live under `os.tmpdir()`, for Expo and the community CLI
 * alike, so `dir` becomes the bundler's `TMPDIR`. Emptied on `reset` or once older than `maxAgeMs`; marks `dir` used
 * and deletes the project's other caches no bundle used within `maxIdleMs`. Best effort: a prune that fails is skipped.
 */
export function prepareMetroCache(dir: string, options: PrepareMetroCacheOptions): MetroCache {
	const created = createdAt(dir);
	const expired = created !== undefined && options.now - created > (options.maxAgeMs ?? METRO_CACHE_MAX_AGE_MS);
	if (options.reset || expired) rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	if (options.reset || expired || created === undefined) writeFileSync(join(dir, CREATED), String(options.now));
	const now = new Date(options.now);
	utimesSync(dir, now, now);
	pruneIdle(dirname(dir), dir, options.now - (options.maxIdleMs ?? METRO_CACHE_MAX_IDLE_MS));
	const storeDir = join(dir, STORE);
	let stored = false;
	try {
		stored = statSync(storeDir).isDirectory();
	} catch {
		stored = false;
	}
	return { tmpdir: `${dir}/`, storeDir, resetCache: !stored };
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
