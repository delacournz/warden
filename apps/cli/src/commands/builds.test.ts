import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeApp } from "@delacour/warden-core/builds/builds.testing";
import { listBuilds, storeArtifact } from "@delacour/warden-core/builds/cache";
import { buildLockKey, buildResource } from "@delacour/warden-core/builds/lock";
import { fakeExec, scriptedUi, type TestContext, testContext } from "../testing";
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

	test("no subcommand → ls", async () => {
		const c = setup([]);
		expect(await buildsCommand.run(c)).toBe(0);
		expect(c.stdout.join("\n")).toContain("no cached builds");
		c.stdout.length = 0;
		c.argv = ["--json"];
		expect(await buildsCommand.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toEqual({ builds: [], totalBytes: 0 });
	});

	test("prune in a terminal: shows what goes, confirm yes → removed under a spinner", async () => {
		const c = setup(["prune", "--max-size", "12"]);
		const ui = scriptedUi({ interactive: true, confirm: [true] });
		c.ui = ui;
		const oldest = await seed(c, "a", 1);
		await seed(c, "b", 2);
		expect(await buildsCommand.run(c)).toBe(0);
		expect(c.stderr.join("\n")).toContain("will remove k ios a (12B)");
		expect(ui.events).toEqual(["confirm: Remove 1 cached build(s) (12B)?", "spin: pruning 1 build(s)…", "stop"]);
		expect(existsSync(oldest)).toBe(false);
		expect(listBuilds(c.db).map((b) => b.hash)).toEqual(["b"]);
		expect(c.stdout.join("\n")).toContain("removed k ios a");
	});

	test("prune in a terminal: confirm no / cancel → exit 1, nothing removed", async () => {
		for (const answer of [false, undefined]) {
			const c = setup(["prune", "--max-size", "1"]);
			const ui = scriptedUi({ interactive: true, confirm: [answer] });
			c.ui = ui;
			await seed(c, "a", 1);
			expect(await buildsCommand.run(c)).toBe(1);
			expect(ui.events.at(-1)).toBe("cancelled: Aborted.");
			expect(listBuilds(c.db)).toHaveLength(1);
			c.cleanup();
			ctx = undefined;
		}
	});

	test("prune --yes / nothing to remove → no prompt", async () => {
		const c = setup(["prune", "--max-size", "1", "--yes"]);
		const ui = scriptedUi({ interactive: true });
		c.ui = ui;
		await seed(c, "a", 1);
		expect(await buildsCommand.run(c)).toBe(0);
		expect(listBuilds(c.db)).toEqual([]);
		c.argv = ["prune"];
		expect(await buildsCommand.run(c)).toBe(0);
		expect(ui.events.some((e) => e.startsWith("confirm"))).toBe(false);
	});

	test("import runs under a spinner", async () => {
		const c = setup(["import", "src/App.app", "--hash", "H1"]);
		const ui = scriptedUi();
		c.ui = ui;
		fakeApp(join(c.cwd, "src"));
		expect(await buildsCommand.run(c)).toBe(0);
		expect(ui.events[0]).toStartWith("spin: importing");
		expect(c.stdout.join("\n")).toContain("imported ios H1");
	});

	test("unknown subcommand → exit 1", async () => {
		const c = setup(["frobnicate"]);
		expect(await buildsCommand.run(c)).toBe(1);
	});
});
