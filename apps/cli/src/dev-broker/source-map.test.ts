import { describe, expect, test } from "bun:test";
import {
	createSourceMapCache,
	findSource,
	originalToGenerated,
	parseSourceMap,
	type Segment,
	sourceMapLocation,
	walkMappings,
} from "./source-map";
import { METRO_BUNDLE_URL, METRO_MAP } from "./source-map.testing";

const metro = parseSourceMap(JSON.stringify(METRO_MAP));
if (!metro.success) throw new Error("fixture does not parse");
const map = metro.data;

describe("walkMappings", () => {
	test("decodes the spec's own examples", () => {
		const seen: Segment[] = [];
		walkMappings("AAAA;AACA,CAAC", (s) => seen.push(s));
		expect(seen).toEqual([
			{ genLine: 0, genCol: 0, source: 0, origLine: 0, origCol: 0 },
			{ genLine: 1, genCol: 0, source: 0, origLine: 1, origCol: 0 },
			{ genLine: 1, genCol: 1, source: 0, origLine: 1, origCol: 1 },
		]);
	});

	test("negative deltas, multi-digit values and a name field", () => {
		const seen: Segment[] = [];
		// 'gC' is the two-digit value 32; 'D' is -1 and 'F' -2; the fifth field of each segment is a name index
		walkMappings("gCAAA,DAAFA,CAACAA", (s) => seen.push(s));
		expect(seen.map((s) => [s.genCol, s.origLine, s.origCol])).toEqual([
			[32, 0, 0],
			[31, 0, -2],
			[32, 0, -1],
		]);
	});

	test("one-field segments are skipped and a bad character throws", () => {
		const seen: Segment[] = [];
		walkMappings("A,AAAA", (s) => seen.push(s));
		expect(seen).toHaveLength(1);
		expect(() => walkMappings("A!AA", () => undefined)).toThrow();
	});
});

describe("findSource", () => {
	test("a unique suffix matches", () => {
		expect(findSource(map, "src/greet.ts")).toEqual({ success: true, data: 0 });
		expect(findSource(map, "./src/greet.ts")).toEqual({ success: true, data: 0 });
		expect(findSource(map, "/Users/dev/app/src/greet.ts")).toEqual({ success: true, data: 0 });
	});

	test("a suffix on several sources is ambiguous and lists them", () => {
		const found = findSource(map, "src/App.tsx");
		expect(found.success).toBe(false);
		if (found.success) return;
		expect(found.error.code).toBe("ambiguous_source");
		expect(found.error.message).toContain("/Users/dev/app/src/App.tsx");
		expect(found.error.message).toContain("/Users/dev/app/packages/ui/src/App.tsx");
		expect(findSource(map, "app/src/App.tsx")).toEqual({ success: true, data: 1 });
		expect(findSource(map, "ui/src/App.tsx")).toEqual({ success: true, data: 2 });
	});

	test("an unknown file is source_not_found", () => {
		const found = findSource(map, "src/nope.ts");
		expect(!found.success && found.error.code).toBe("source_not_found");
	});

	test("Metro's /[metro-project]/ root is an exact match", () => {
		const rooted = {
			sources: ["/[metro-project]/src/x.ts", "/[metro-project]/packages/a/src/x.ts"],
			mappings: "",
		};
		expect(findSource(rooted, "src/x.ts")).toEqual({ success: true, data: 0 });
		expect(findSource(rooted, "packages/a/src/x.ts")).toEqual({ success: true, data: 1 });
	});
});

describe("originalToGenerated on a Metro-generated map", () => {
	test("the first mapping on a line, 1-based in and 0-based out", () => {
		expect(originalToGenerated(map, "src/greet.ts", 2)).toEqual({
			success: true,
			data: { source: "/Users/dev/app/src/greet.ts", line: 2, col: 9, generatedLine: 1, generatedColumn: 2 },
		});
	});

	test("a column picks the first mapping at or after it", () => {
		const resolved = originalToGenerated(map, "src/greet.ts", 2, 10);
		expect(resolved.success && [resolved.data.col, resolved.data.generatedColumn]).toEqual([15, 8]);
	});

	test("a line with no code snaps to the next one that has some", () => {
		const resolved = originalToGenerated(map, "src/greet.ts", 4);
		expect(resolved.success).toBe(false);
		const snapped = originalToGenerated(map, "app/src/App.tsx", 1);
		expect(snapped.success && snapped.data.line).toBe(1);
	});

	test("a second module maps past the first one's generated lines", () => {
		const resolved = originalToGenerated(map, "app/src/App.tsx", 3);
		expect(resolved.success && resolved.data.generatedLine).toBeGreaterThan(2);
	});

	test("ambiguity is surfaced", () => {
		const resolved = originalToGenerated(map, "src/App.tsx", 1);
		expect(!resolved.success && resolved.error.code).toBe("ambiguous_source");
	});
});

describe("sourceMapLocation", () => {
	test("falls back to .bundle -> .map with the same query on Metro's own origin", () => {
		expect(sourceMapLocation(METRO_BUNDLE_URL, undefined, "http://127.0.0.1:9000")).toEqual({
			kind: "url",
			url: "http://127.0.0.1:9000/index.map?platform=ios&dev=true",
		});
	});

	test("a JSC-safe bundle URL (`//&query`, what React Native loads) maps to the plain .map?query", () => {
		const jscSafe = "http://localhost:8082/apps/example/index.ts.bundle//&platform=ios&dev=true";
		expect(sourceMapLocation(jscSafe, undefined, "http://127.0.0.1:8082")).toEqual({
			kind: "url",
			url: "http://127.0.0.1:8082/apps/example/index.ts.map?platform=ios&dev=true",
		});
	});

	test("uses sourceMapURL, resolved against the bundle, and decodes data URIs", () => {
		expect(sourceMapLocation(METRO_BUNDLE_URL, "/other.map?x=1", "http://m:1")).toEqual({
			kind: "url",
			url: "http://m:1/other.map?x=1",
		});
		const data = `data:application/json;base64,${Buffer.from('{"a":1}').toString("base64")}`;
		expect(sourceMapLocation(METRO_BUNDLE_URL, data, "http://m:1")).toEqual({ kind: "data", text: '{"a":1}' });
	});
});

describe("createSourceMapCache", () => {
	test("fetches once per bundle until invalidated; failures are not cached", async () => {
		const urls: string[] = [];
		let ok = false;
		const cache = createSourceMapCache({
			metroUrl: "http://m:1",
			fetch: async (url) => {
				urls.push(url);
				return ok
					? { ok: true, status: 200, text: async () => JSON.stringify(METRO_MAP) }
					: { ok: false, status: 500, text: async () => "" };
			},
		});
		expect((await cache.get(METRO_BUNDLE_URL)).success).toBe(false);
		ok = true;
		expect((await cache.get(METRO_BUNDLE_URL)).success).toBe(true);
		expect((await cache.get(METRO_BUNDLE_URL)).success).toBe(true);
		expect(urls).toHaveLength(2);
		cache.invalidate(METRO_BUNDLE_URL);
		await cache.get(METRO_BUNDLE_URL);
		expect(urls).toHaveLength(3);
	});
});
