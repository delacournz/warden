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
import { METRO_CACHE_DIR_NAME, METRO_CACHE_MAX_AGE_MS, METRO_CACHE_MAX_IDLE_MS } from "./builds.defaults";
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

	test("the project's .env* files are bundle env too: Expo inlines their EXPO_PUBLIC_* values", () => {
		const root = join(home, "app");
		mkdirSync(root);
		const withRoot = () =>
			metroCacheDir({ env: { WARDEN_HOME: home }, root, projectKey: KEY, platform: "ios", flags: [] });
		writeFileSync(join(root, ".env"), "EXPO_PUBLIC_API=a\n");
		const a = withRoot();
		writeFileSync(join(root, ".env"), "EXPO_PUBLIC_API=b\n");
		expect(withRoot()).not.toBe(a);
		writeFileSync(join(root, ".env"), "EXPO_PUBLIC_API=a\n");
		expect(withRoot()).toBe(a);
		writeFileSync(join(root, ".env.production.local"), "EXPO_PUBLIC_API=c\n");
		expect(withRoot()).not.toBe(a);
		// other dotfiles are not env
		rmSync(join(root, ".env.production.local"));
		writeFileSync(join(root, ".envrc-not"), "");
		writeFileSync(join(root, ".gitignore"), "x");
		expect(withRoot()).toBe(a);
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
		const ready = prepareMetroCache(dir, { now: Date.now() });
		expect(ready.tmpdir).toBe(`${dir}/`);
		expect(ready.storeDir).toBe(join(dir, "metro-cache"));
		expect(existsSync(dir)).toBe(true);
	});

	test("resetCache until Metro has written its store here: free on an empty dir, and a project whose own cacheStores live elsewhere keeps the reset", () => {
		const dir = dirOf();
		expect(prepareMetroCache(dir, { now: Date.now() }).resetCache).toBe(true);
		expect(prepareMetroCache(dir, { now: Date.now() }).resetCache).toBe(true);
		mkdirSync(join(dir, "metro-cache"));
		expect(prepareMetroCache(dir, { now: Date.now() }).resetCache).toBe(false);
		expect(prepareMetroCache(dir, { now: Date.now(), reset: true }).resetCache).toBe(true);
	});

	test("a cache older than the max age starts afresh, so the dir never grows without bound", () => {
		const now = Date.now();
		const dir = dirOf();
		prepareMetroCache(dir, { now: now - METRO_CACHE_MAX_AGE_MS - DAY });
		writeFileSync(join(dir, "transform"), "x");
		prepareMetroCache(dir, { now: now - DAY });
		expect(readdirSync(dir)).toContain("transform");
		prepareMetroCache(dir, { now });
		expect(readdirSync(dir)).not.toContain("transform");
		// and the new one is dated now: it lives another max age
		writeFileSync(join(dir, "transform"), "x");
		prepareMetroCache(dir, { now: now + DAY });
		expect(readdirSync(dir)).toContain("transform");
	});

	test("keeps what an earlier bundle cached; reset empties it", () => {
		const dir = dirOf();
		prepareMetroCache(dir, { now: Date.now() });
		writeFileSync(join(dir, "transform"), "x");
		prepareMetroCache(dir, { now: Date.now() });
		expect(readdirSync(dir)).toContain("transform");
		prepareMetroCache(dir, { now: Date.now(), reset: true });
		expect(readdirSync(dir)).not.toContain("transform");
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
