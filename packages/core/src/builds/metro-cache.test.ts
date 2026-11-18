import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { METRO_CACHE_DIR_NAME, METRO_CACHE_MAX_IDLE_MS } from "./builds.defaults";
import { metroCacheDir, prepareMetroCache } from "./metro-cache";
import { safeKey } from "./project-key";

let home: string;
const KEY = "github.com/o/r:app";
const DAY = 24 * 60 * 60_000;

beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "warden-metro-cache-")));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const dirOf = (
	over: { env?: Record<string, string | undefined>; flags?: string[]; platform?: "ios" | "android" } = {}
) =>
	metroCacheDir({
		env: { WARDEN_HOME: home, ...over.env },
		projectKey: KEY,
		platform: over.platform ?? "ios",
		flags: over.flags ?? ["export:embed", "--minify", "false"],
	});

describe("metroCacheDir", () => {
	test("one dir per project under $WARDEN_HOME/metro-cache, per platform", () => {
		const dir = dirOf();
		expect(dirname(dir)).toBe(join(home, METRO_CACHE_DIR_NAME, safeKey(KEY)));
		expect(dirOf()).toBe(dir);
		expect(dirOf({ platform: "android" })).not.toBe(dir);
	});

	test("another bundle env value or bundler flag is another cache, so inlined values never go stale", () => {
		const dir = dirOf({ env: { EXPO_PUBLIC_API: "a" } });
		expect(dirOf({ env: { EXPO_PUBLIC_API: "b" } })).not.toBe(dir);
		expect(dirOf({ env: { EXPO_PUBLIC_API: "a", NODE_ENV: "test" } })).not.toBe(dir);
		expect(dirOf({ env: { EXPO_PUBLIC_API: "a" }, flags: ["bundle"] })).not.toBe(dir);
		// env the bundle never sees does not split the cache
		expect(dirOf({ env: { EXPO_PUBLIC_API: "a", PATH: "/x", CI: "true" } })).toBe(dir);
	});

	test("kind env is bundle env, whatever its name", () => {
		const plain = metroCacheDir({ env: { WARDEN_HOME: home }, projectKey: KEY, platform: "ios", flags: [] });
		const kind = metroCacheDir({
			env: { WARDEN_HOME: home },
			kindEnv: { MY_FLAG: "1" },
			projectKey: KEY,
			platform: "ios",
			flags: [],
		});
		expect(kind).not.toBe(plain);
	});
});

describe("prepareMetroCache", () => {
	test("creates the dir and returns it as a TMPDIR value (Metro's cache root is $TMPDIR/metro-cache)", () => {
		const dir = dirOf();
		expect(prepareMetroCache(dir, { now: Date.now() })).toBe(`${dir}/`);
		expect(existsSync(dir)).toBe(true);
	});

	test("keeps what an earlier bundle cached; reset empties it", () => {
		const dir = dirOf();
		prepareMetroCache(dir, { now: Date.now() });
		writeFileSync(join(dir, "transform"), "x");
		prepareMetroCache(dir, { now: Date.now() });
		expect(readdirSync(dir)).toEqual(["transform"]);
		prepareMetroCache(dir, { now: Date.now(), reset: true });
		expect(readdirSync(dir)).toEqual([]);
	});

	test("touches its own dir and prunes the project's caches idle past the limit", () => {
		const now = Date.now();
		const dir = dirOf();
		const stale = dirOf({ env: { EXPO_PUBLIC_API: "old" } });
		const recent = dirOf({ env: { EXPO_PUBLIC_API: "recent" } });
		for (const d of [dir, stale, recent]) mkdirSync(d, { recursive: true });
		const old = new Date(now - METRO_CACHE_MAX_IDLE_MS - DAY);
		utimesSync(stale, old, old);
		utimesSync(dir, old, old);
		utimesSync(recent, new Date(now - DAY), new Date(now - DAY));
		prepareMetroCache(dir, { now });
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(recent)).toBe(true);
		expect(existsSync(dir)).toBe(true);
		expect(statSync(dir).mtimeMs).toBeGreaterThan(now - 60_000);
	});
});
