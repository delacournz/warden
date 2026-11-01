import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsFixtures } from "@delacour/warden-perf/js/js.testing";
import { jsResultFactory } from "@delacour/warden-perf/js/js.types";
import type { JsDeps } from "@delacour/warden-sdk/ops/perf/js-capture";
import { resultFactory } from "@delacour/warden-types/result";
import { cliTesting, type TestContext } from "../testing";
import { perfHeapCli } from "./heap";
import { perfTestingCli } from "./testing";

let ctx: TestContext | undefined;
const dirs: string[] = [];
afterEach(() => {
	ctx?.cleanup();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 9, 24, 10, 15, 0);
const sim = { platform: "ios", id: "U1", name: "warden-iphone-17-1" } as const;
const METRO = "http://127.0.0.1:8081";

const SNAPSHOT = jsFixtures.buildHeapSnapshot([
	["object", "Cart", 300],
	["object", "Cart", 300],
	["object", "Item", 50],
	["string", "x", 10],
]);

function setup(chunks: string[] = [SNAPSHOT.slice(0, 40), SNAPSHOT.slice(40)]) {
	const c = cliTesting.testContext([], { now: () => T0 });
	ctx = c;
	perfTestingCli.asMe(c);
	c.db.recordDevice({ platform: "ios", id: "U1", name: sim.name }, T0);
	const deps = perfTestingCli.fakePerfDeps([sim], { U1: "com.acme.shop" }, { metro: async () => METRO });
	const cdp = jsFixtures.fakeCdp(
		{ "Runtime.evaluate": { result: { value: false } } },
		{ "HeapProfiler.takeHeapSnapshot": chunks.map((chunk) => ({ chunk })) }
	);
	const js: JsDeps = {
		open: async () => resultFactory.ok({ ...cdp, close: () => undefined }),
		fetchMap: async () => jsResultFactory.ok(""),
		sleep: async () => undefined,
	};
	return { c, deps, js, cdp };
}

const snap = (s: ReturnType<typeof setup>, opts: Record<string, unknown> = {}) =>
	perfHeapCli.perfHeapSnapshot(s.c, s.deps, { json: true, claim: true, app: "com.acme.shop", ...opts }, s.js);

describe("warden perf heap snapshot", () => {
	test("streams chunks into js/heap-<ts>.heapsnapshot and summarizes the top constructors", async () => {
		const s = setup();
		expect(await snap(s)).toBe(0);
		const doc = JSON.parse(s.c.stdout.join("\n"));
		expect(doc.result.file).toMatch(/\/js\/heap-20261024T101500Z\.heapsnapshot$/);
		expect(readFileSync(doc.result.file, "utf8")).toBe(SNAPSHOT);
		expect(doc.result.bytes).toBe(SNAPSHOT.length);
		expect(doc.result.summary.topBySize[0]).toEqual({ name: "Cart", count: 2, selfSize: 600 });
		expect(existsSync(doc.result.summaryFile)).toBe(true);
	});

	test("it mutates: no lease and no --claim is refused", async () => {
		const s = setup();
		expect(await perfHeapCli.perfHeapSnapshot(s.c, s.deps, { json: true, app: "com.acme.shop" }, s.js)).toBe(2);
	});

	test("a runtime without the method: engine_unavailable, and no half-written file is left", async () => {
		const s = setup();
		const bare = jsFixtures.fakeCdp({
			"HeapProfiler.takeHeapSnapshot": { __error: "'HeapProfiler.takeHeapSnapshot' wasn't found" },
		});
		s.js.open = async () => resultFactory.ok({ ...bare, close: () => undefined });
		expect(await snap(s)).toBe(3);
		const doc = JSON.parse(s.c.stdout.join("\n"));
		expect(doc.error).toMatchObject({ code: "engine_unavailable" });
		expect(doc.error.message).toContain("takeHeapSnapshot");
		const root = join(s.c.env.WARDEN_HOME ?? "", "perf");
		const leftovers = existsSync(root)
			? readdirSync(root, { recursive: true }).filter((f) => String(f).endsWith(".heapsnapshot"))
			: [];
		expect(leftovers).toEqual([]);
	});

	test("an unparseable snapshot is kept and warned about", async () => {
		const s = setup(["not json"]);
		expect(await snap(s)).toBe(0);
		const doc = JSON.parse(s.c.stdout.join("\n"));
		expect(existsSync(doc.result.file)).toBe(true);
		expect(doc.result.summary).toBeUndefined();
		expect(doc.warnings[0]).toContain("not summarized");
	});

	test("text mode lists the top constructors and a diff hint", async () => {
		const s = setup();
		expect(await perfHeapCli.perfHeapSnapshot(s.c, s.deps, { claim: true, app: "com.acme.shop" }, s.js)).toBe(0);
		const text = s.c.stdout.join("\n");
		expect(text).toContain("Cart");
		expect(text).toContain("warden perf heap diff");
	});
});

describe("warden perf heap diff", () => {
	function files(a: string, b: string) {
		const dir = mkdtempSync(join(tmpdir(), "warden-heap-"));
		dirs.push(dir);
		writeFileSync(join(dir, "a.heapsnapshot"), a);
		writeFileSync(join(dir, "b.heapsnapshot"), b);
		return dir;
	}

	test("constructor deltas, biggest first", () => {
		const dir = files(
			SNAPSHOT,
			jsFixtures.buildHeapSnapshot([
				["object", "Cart", 300],
				["object", "Cart", 300],
				["object", "Cart", 300],
				["object", "Item", 50],
				["string", "x", 10],
			])
		);
		const c = cliTesting.testContext([], { cwd: dir });
		ctx = c;
		expect(perfHeapCli.perfHeapDiff(c, "a.heapsnapshot", "b.heapsnapshot", { json: true })).toBe(0);
		const doc = JSON.parse(c.stdout.join("\n"));
		expect(doc.rows).toEqual([
			{ name: "Cart", countA: 2, countB: 3, countDelta: 1, sizeA: 600, sizeB: 900, sizeDelta: 300 },
		]);
		expect(doc.totalSizeDelta).toBe(300);
	});

	test("text mode", () => {
		const dir = files(SNAPSHOT, SNAPSHOT);
		const c = cliTesting.testContext([], { cwd: dir });
		ctx = c;
		expect(perfHeapCli.perfHeapDiff(c, "a.heapsnapshot", "b.heapsnapshot", {})).toBe(0);
		expect(c.stdout.join("\n")).toContain("Heap diff");
	});

	test("a missing or non-snapshot file is a usage error", () => {
		const dir = files(SNAPSHOT, "nope");
		const c = cliTesting.testContext([], { cwd: dir });
		ctx = c;
		expect(perfHeapCli.perfHeapDiff(c, "a.heapsnapshot", "missing.heapsnapshot", { json: true })).toBe(1);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({ ok: false, error: { code: "usage" } });
		c.stdout.length = 0;
		expect(perfHeapCli.perfHeapDiff(c, "a.heapsnapshot", "b.heapsnapshot", { json: true })).toBe(1);
	});
});

describe("registration", () => {
	test("js, heap snapshot and heap diff are wired onto warden perf", async () => {
		const { PerfCommand } = await import("../commands/perf");
		const { perfJsCli } = await import("./js");
		const { perfHeapCli } = await import("./heap");
		const s = setup();
		const c = cliTesting.testContext(["heap", "--help"]);
		ctx = c;
		expect(await new PerfCommand(s.deps, [perfJsCli.registerJs, perfHeapCli.registerHeap]).definition().run(c)).toBe(0);
		const help = c.stdout.join("\n");
		expect(help).toContain("snapshot");
		expect(help).toContain("diff");
		const c2 = cliTesting.testContext(["js", "--help"]);
		expect(await new PerfCommand(s.deps, [perfJsCli.registerJs, perfHeapCli.registerHeap]).definition().run(c2)).toBe(
			0
		);
		expect(c2.stdout.join("\n")).toContain("--duration");
		c2.cleanup();
	});
});
