import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildResource } from "@delacour/warden-core/builds/lock";
import type { PodsDeps, PodsEntry, PodsInstallOptions, PodsOutcome } from "@delacour/warden-core/pods/pods.types";
import { insertPodsEntry, listPodsEntries, podsEntryDir, podsLockKey } from "@delacour/warden-core/pods/pods-store";
import { expectContract } from "../contracts/contracts.testing";
import { fakeExec, type TestContext, testContext } from "../testing";
import { createPodsCommand, installJson } from "./pods";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const DAY = 86_400_000;
const NOW = 1_000 * DAY;

type Seen = { deps: PodsDeps; opts: PodsInstallOptions };

function setup(argv: string[], outcome: PodsOutcome | string, seen: Seen[] = [], pidAlive = () => false) {
	ctx = testContext(argv, { now: () => NOW });
	const root = realpathSync(ctx.cwd);
	ctx.exec = fakeExec([
		["git rev-parse --show-toplevel --git-common-dir", { stdout: `${root}\n${root}/.git\nrefs/heads/main\n` }],
		["git config --get remote.origin.url", { stdout: "git@github.com:o/r.git" }],
		["git", { exitCode: 1 }],
	]);
	writeFileSync(
		join(ctx.cwd, "app.json"),
		JSON.stringify({ expo: { slug: "demo", ios: { bundleIdentifier: "com.demo" } } })
	);
	const cmd = createPodsCommand({
		pid: 1,
		pidAlive,
		sleep: async () => {},
		install: async (deps, opts) => {
			seen.push({ deps, opts });
			deps.log("Installing pods");
			return typeof outcome === "string" ? { success: false, error: outcome } : { success: true, data: outcome };
		},
	});
	return { c: ctx, cmd, root };
}

function entry(key: string, over: Partial<PodsEntry> = {}): PodsEntry {
	return {
		key,
		mode: "cng",
		root: "/r",
		projectRel: "apps/mobile",
		sizeBytes: 1024 * 1024,
		createdAt: NOW - 2 * DAY,
		lastUsedAt: NOW - DAY,
		podVersion: "1.16.2",
		xcodeVersion: "27.0",
		...over,
	};
}

function seed(c: TestContext, e: PodsEntry): void {
	insertPodsEntry(c.db, e);
	mkdirSync(podsEntryDir(c.env, e.key), { recursive: true });
}

const KEY = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

describe("warden pods install", () => {
	test("hit: one status line, stderr gets pod output, options reach the cache", async () => {
		const seen: Seen[] = [];
		const { c, cmd } = setup(
			["install", "--project-directory", "native/ios", "--", "--repo-update"],
			{ kind: "hit", key: KEY, mode: "cng", ms: 800 },
			seen
		);
		expect(await cmd.run(c)).toBe(0);
		expect(c.stdout.join("\n")).toContain("✓ pods restored a1b2c3d4e5f6 (0.8s)");
		expect(c.stderr.join("\n")).toContain("Installing pods");
		expect(seen[0]?.opts).toMatchObject({
			projectRoot: expect.stringMatching(/warden-cli-/),
			iosDir: "native/ios",
			podArgs: ["--repo-update"],
			framework: "expo",
		});
		expect(seen[0]?.opts.noCache).toBeUndefined();
	});

	test("miss stored", async () => {
		const { c, cmd } = setup(["install"], { kind: "miss", key: KEY, mode: "cng", ms: 31_000, stored: true });
		expect(await cmd.run(c)).toBe(0);
		expect(c.stdout.join("\n")).toContain("✓ pods installed and cached a1b2c3d4e5f6 (31.0s)");
	});

	test("miss not stored, uncached and up to date", async () => {
		let s = setup(["install"], {
			kind: "miss",
			key: KEY,
			mode: "committed",
			ms: 1,
			stored: false,
			storeError: "disk full",
		});
		expect(await s.cmd.run(s.c)).toBe(0);
		expect(s.c.stdout.join("\n")).toContain("! pods installed, not cached: disk full");
		ctx?.cleanup();
		s = setup(["install", "--no-cache"], { kind: "uncached", reason: "--no-cache", ms: 5 });
		expect(await s.cmd.run(s.c)).toBe(0);
		expect(s.c.stdout.join("\n")).toContain("! pods installed, not cached: --no-cache");
		ctx?.cleanup();
		s = setup(["install"], { kind: "up-to-date", key: KEY, mode: "cng", ms: 2 });
		expect(await s.cmd.run(s.c)).toBe(0);
		expect(s.c.stdout.join("\n")).toContain("· pods up to date");
	});

	test("--no-cache is passed on", async () => {
		const seen: Seen[] = [];
		const { c, cmd } = setup(["install", "--no-cache"], { kind: "uncached", reason: "--no-cache", ms: 5 }, seen);
		await cmd.run(c);
		expect(seen[0]?.opts.noCache).toBe(true);
	});

	test("--json: one document per outcome, valid under the contract", async () => {
		const outcomes: Array<[string, PodsOutcome]> = [
			["hit", { kind: "hit", key: KEY, mode: "cng", ms: 800 }],
			["up-to-date", { kind: "up-to-date", key: KEY, mode: "committed", ms: 2 }],
			["miss", { kind: "miss", key: KEY, mode: "cng", ms: 31_000, stored: true }],
			["miss-not-stored", { kind: "miss", key: KEY, mode: "cng", ms: 31_000, stored: false, storeError: "disk full" }],
			["uncached", { kind: "uncached", reason: "--no-cache", ms: 5 }],
		];
		for (const [name, outcome] of outcomes) {
			const { c, cmd } = setup(["install", "--json"], outcome);
			expect(await cmd.run(c)).toBe(0);
			const doc = JSON.parse(c.stdout.join("\n"));
			expect(doc).toEqual(installJson(outcome));
			expectContract("warden.pods.install", doc, { name });
			ctx?.cleanup();
		}
	});

	test("a failed install exits 1 with the reason", async () => {
		const { c, cmd } = setup(["install"], "pod install failed: boom");
		expect(await cmd.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("pod install failed: boom");
	});
});

describe("warden pods ls / rm / prune", () => {
	const noop: PodsOutcome = { kind: "up-to-date", key: KEY, mode: "cng", ms: 1 };

	test("ls table and --json", async () => {
		const { c, cmd } = setup(["ls"], noop);
		seed(c, entry(KEY));
		expect(await cmd.run(c)).toBe(0);
		const text = c.stdout.join("\n");
		expect(text).toContain("a1b2c3d4e5f6");
		expect(text).toContain("apps/mobile");
		expect(text).toContain("1.0M");
		c.stdout.length = 0;
		c.argv = ["ls", "--json"];
		expect(await cmd.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n")).entries).toHaveLength(1);
	});

	test("ls with nothing cached", async () => {
		const { c, cmd } = setup([], noop);
		expect(await cmd.run(c)).toBe(0);
		expect(c.stdout.join("\n")).toContain("no cached pods");
	});

	test("rm by prefix removes row and files; --dry-run keeps both", async () => {
		const { c, cmd } = setup(["rm", "a1b2c3", "--dry-run"], noop);
		seed(c, entry(KEY));
		expect(await cmd.run(c)).toBe(0);
		expect(c.stdout.join("\n")).toContain("would remove a1b2c3d4e5f6");
		expect(listPodsEntries(c.db)).toHaveLength(1);
		c.argv = ["rm", "a1b2c3"];
		expect(await cmd.run(c)).toBe(0);
		expect(listPodsEntries(c.db)).toHaveLength(0);
		expect(existsSync(podsEntryDir(c.env, KEY))).toBe(false);
	});

	test("rm refuses a short, unknown or ambiguous prefix", async () => {
		const { c, cmd } = setup(["rm", "a1b"], noop);
		seed(c, entry(KEY));
		seed(c, entry("a1b2c3ffffffffffffffffffffffffff"));
		expect(await cmd.run(c)).toBe(1);
		c.argv = ["rm", "zzzzzz"];
		expect(await cmd.run(c)).toBe(1);
		c.argv = ["rm", "a1b2c3"];
		expect(await cmd.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("matches 2 entries");
		expect(listPodsEntries(c.db)).toHaveLength(2);
	});

	test("rm leaves a key being installed", async () => {
		const { c, cmd } = setup(["rm", "a1b2c3"], noop, [], () => true);
		seed(c, entry(KEY));
		c.db.insertLease(
			{ resource: buildResource(podsLockKey(KEY)), owner: { kind: "ci", runId: "x" }, ttlMs: 60_000 },
			c.now()
		);
		expect(await cmd.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("being installed");
	});

	test("prune: old entries go, recent ones stay; --dry-run only reports", async () => {
		const { c, cmd } = setup(["prune", "--dry-run", "--json"], noop);
		seed(c, entry("old00000000000000000000000000000", { lastUsedAt: NOW - 40 * DAY }));
		seed(c, entry(KEY));
		expect(await cmd.run(c)).toBe(0);
		const dry = JSON.parse(c.stdout.join("\n"));
		expect(dry.removed.map((e: PodsEntry) => e.key)).toEqual(["old00000000000000000000000000000"]);
		expect(listPodsEntries(c.db)).toHaveLength(2);
		c.stdout.length = 0;
		c.argv = ["prune"];
		expect(await cmd.run(c)).toBe(0);
		expect(listPodsEntries(c.db).map((e) => e.key)).toEqual([KEY]);
	});

	test("prune --max-size trims least recently used; bad values fail", async () => {
		const { c, cmd } = setup(["prune", "--max-size", "1M", "--older-than", "999d"], noop);
		seed(c, entry("old00000000000000000000000000000", { lastUsedAt: NOW - 5 * DAY }));
		seed(c, entry(KEY));
		expect(await cmd.run(c)).toBe(0);
		expect(listPodsEntries(c.db).map((e) => e.key)).toEqual([KEY]);
		c.argv = ["prune", "--max-size", "lots"];
		expect(await cmd.run(c)).toBe(1);
		c.argv = ["prune", "--older-than", "soon"];
		expect(await cmd.run(c)).toBe(1);
	});
});
