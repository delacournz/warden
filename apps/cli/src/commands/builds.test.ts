import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeApp } from "@warden/core/builds/builds.testing";
import { listBuilds, storeArtifact } from "@warden/core/builds/cache";
import { buildLockKey, buildResource } from "@warden/core/builds/lock";
import { fakeExec, type TestContext, testContext } from "../testing";
import { buildsCommand, inferPlatform } from "./builds";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

function setup(argv: string[]): TestContext {
	ctx = testContext(argv);
	ctx.exec = fakeExec([
		["git rev-parse --show-toplevel", { stdout: realpathSync(ctx.cwd) }],
		["git config --get remote.origin.url", { stdout: "git@github.com:o/r.git" }],
		["git", { exitCode: 1 }],
	]);
	writeFileSync(
		join(ctx.cwd, "app.json"),
		JSON.stringify({ expo: { slug: "demo", ios: { bundleIdentifier: "com.demo" } } })
	);
	return ctx;
}

async function seed(c: TestContext, hash: string, lastUsed: number): Promise<string> {
	const res = await storeArtifact({
		store: c.db,
		env: c.env,
		projectKey: "k",
		platform: "ios",
		profile: "p",
		hash,
		artifact: fakeApp(join(c.cwd, "src", hash)),
		source: "eas",
		now: lastUsed,
	});
	if (!res.success) throw new Error(res.error);
	return res.data.path;
}

describe("inferPlatform", () => {
	test("from extension or flag", () => {
		expect(inferPlatform("/x/App.app/", undefined)).toEqual({ success: true, data: "ios" });
		expect(inferPlatform("/x/a.apk", undefined)).toEqual({ success: true, data: "android" });
		expect(inferPlatform("/x/a.zip", undefined).success).toBe(false);
		expect(inferPlatform("/x/a.zip", "android")).toEqual({ success: true, data: "android" });
	});
});

describe("warden builds", () => {
	test("import copies into the cache keyed by the git remote; ls shows it", async () => {
		const c = setup(["import", "src/App.app", "--hash", "H1", "--json"]);
		fakeApp(join(c.cwd, "src"));
		expect(await buildsCommand.run(c)).toBe(0);
		const imported = JSON.parse(c.stdout.join("\n"));
		expect(imported).toMatchObject({
			projectKey: "github.com/o/r:.",
			platform: "ios",
			hash: "H1",
			source: "import",
			size: 12,
		});
		expect(existsSync(imported.path)).toBe(true);

		c.stdout.length = 0;
		c.argv = ["ls"];
		expect(await buildsCommand.run(c)).toBe(0);
		const text = c.stdout.join("\n");
		expect(text).toContain("github.com/o/r:.");
		expect(text).toContain("H1");
		expect(text).toContain("total 12B");
	});

	test("import without --hash → exit 1", async () => {
		const c = setup(["import", "x.app"]);
		expect(await buildsCommand.run(c)).toBe(1);
	});

	test("import rejects a missing artifact", async () => {
		const c = setup(["import", "nope.apk", "--hash", "H"]);
		expect(await buildsCommand.run(c)).toBe(1);
	});

	test("prune --max-size removes LRU, keeps build-locked ones", async () => {
		const c = setup(["prune", "--max-size", "12", "--json"]);
		const oldest = await seed(c, "a", 1);
		const mid = await seed(c, "b", 2);
		const newest = await seed(c, "c", 3);
		c.db.insertLease(
			{ resource: buildResource(buildLockKey("k", "ios", "a")), owner: { kind: "ci", runId: "x" }, ttlMs: 60_000 },
			c.now()
		);
		expect(await buildsCommand.run(c)).toBe(0);
		const out = JSON.parse(c.stdout.join("\n"));
		expect(out.removed.map((b: { hash: string }) => b.hash)).toEqual(["b", "c"]);
		expect([oldest, mid, newest].map((p) => existsSync(p))).toEqual([true, false, false]);
		expect(listBuilds(c.db).map((b) => b.hash)).toEqual(["a"]);
	});

	test("prune --dry-run removes nothing; bad size → exit 1", async () => {
		const c = setup(["prune", "--max-size", "1", "--dry-run"]);
		await seed(c, "a", 1);
		expect(await buildsCommand.run(c)).toBe(0);
		expect(c.stdout.join("\n")).toContain("would remove");
		expect(listBuilds(c.db)).toHaveLength(1);
		c.argv = ["prune", "--max-size", "lots"];
		expect(await buildsCommand.run(c)).toBe(1);
	});

	test("unknown subcommand → exit 1", async () => {
		const c = setup(["frobnicate"]);
		expect(await buildsCommand.run(c)).toBe(1);
	});
});
