import { describe, expect, test } from "bun:test";
import { diffHeaps, heapDiffSection, heapSection, parseHeapSnapshot, summarizeHeap, takeHeapSnapshot } from "./heap";
import { buildHeapSnapshot, fakeCdp } from "./js.testing";

const snapshot = buildHeapSnapshot([
	["object", "Foo", 100],
	["object", "Foo", 100],
	["object", "Bar", 500],
	["string", "hello", 40],
	["closure", "fn", 60],
]);

describe("takeHeapSnapshot", () => {
	test("streams chunks to the sink and counts bytes", async () => {
		const cdp = fakeCdp({}, { "HeapProfiler.takeHeapSnapshot": [{ chunk: '{"a":' }, { chunk: "1}" }] });
		const got: string[] = [];
		const taken = await takeHeapSnapshot(cdp, (c) => got.push(c));
		expect(got.join("")).toBe('{"a":1}');
		expect(taken).toEqual({ success: true, data: { bytes: 7, chunks: 2 } });
		expect(cdp.sent.map((s) => s.method)).toEqual([
			"HeapProfiler.enable",
			"HeapProfiler.takeHeapSnapshot",
			"HeapProfiler.disable",
		]);
	});

	test("a runtime without the method is unsupported, with a hint", async () => {
		const cdp = fakeCdp({
			"HeapProfiler.takeHeapSnapshot": { __error: "'HeapProfiler.takeHeapSnapshot' wasn't found" },
		});
		const taken = await takeHeapSnapshot(cdp, () => undefined);
		expect(taken).toMatchObject({ success: false, error: { code: "unsupported" } });
		expect(!taken.success && taken.error.hint).toContain("Hermes");
	});

	test("a reply with no chunks is unsupported", async () => {
		expect(await takeHeapSnapshot(fakeCdp(), () => undefined)).toMatchObject({
			success: false,
			error: { code: "unsupported" },
		});
	});
});

describe("parseHeapSnapshot / summarizeHeap", () => {
	test("groups objects by constructor and other nodes by (type)", () => {
		const parsed = parseHeapSnapshot(snapshot);
		if (!parsed.success) throw new Error("parse");
		expect(parsed.data.nodeCount).toBe(5);
		expect(parsed.data.totalSelfSize).toBe(800);
		expect(parsed.data.constructors.map((c) => [c.name, c.count, c.selfSize])).toEqual([
			["Bar", 1, 500],
			["Foo", 2, 200],
			["(closure)", 1, 60],
			["(string)", 1, 40],
		]);
	});

	test("top by size and by count", () => {
		const parsed = parseHeapSnapshot(snapshot);
		if (!parsed.success) throw new Error("parse");
		const s = summarizeHeap(parsed.data, 2);
		expect(s.topBySize.map((c) => c.name)).toEqual(["Bar", "Foo"]);
		expect(s.topByCount[0]?.name).toBe("Foo");
		expect(heapSection(s).lines.join("\n")).toContain("Foo");
	});

	test("rejects non-snapshots", () => {
		expect(parseHeapSnapshot("nope")).toMatchObject({ success: false, error: { code: "invalid_snapshot" } });
		expect(parseHeapSnapshot("{}")).toMatchObject({ success: false, error: { code: "invalid_snapshot" } });
	});
});

describe("diffHeaps", () => {
	test("count and size deltas per constructor, biggest change first", () => {
		const a = parseHeapSnapshot(snapshot);
		const b = parseHeapSnapshot(
			buildHeapSnapshot([
				["object", "Foo", 100],
				["object", "Foo", 100],
				["object", "Foo", 100],
				["object", "Baz", 1000],
				["string", "hello", 40],
			])
		);
		if (!a.success || !b.success) throw new Error("parse");
		const diff = diffHeaps(a.data, b.data);
		expect(diff.rows.map((r) => [r.name, r.countDelta, r.sizeDelta])).toEqual([
			["Baz", 1, 1000],
			["Bar", -1, -500],
			["Foo", 1, 100],
			["(closure)", -1, -60],
		]);
		expect(diff.totalSizeDelta).toBe(540);
		expect(heapDiffSection(diff).lines.join("\n")).toContain("Baz");
	});
});
