import { describe, expect, test } from "bun:test";
import { jsFixtures } from "./js.testing";
import { jsResultFactory } from "./js.types";
import { jsSymbolicator, MAX_SOURCE_MAP_BYTES, type ScriptInfo } from "./symbolicate";

const METRO = "http://127.0.0.1:8081";
const script = (over: Partial<ScriptInfo> = {}): ScriptInfo => ({
	scriptId: "1",
	url: "http://127.0.0.1:8081/index.bundle?platform=ios&dev=true",
	sourceMapURL: "http://127.0.0.1:8081/index.map?platform=ios&dev=true",
	...over,
});

describe("resolveMapUrl (SSRF guard)", () => {
	test("Metro's own host:port is fetched", () => {
		expect(jsSymbolicator.resolveMapUrl(script(), METRO)).toEqual({
			kind: "fetch",
			url: "http://127.0.0.1:8081/index.map?platform=ios&dev=true",
		});
	});

	test("no sourceMapURL on a JSC-safe bundle (`.bundle//&…`, what Hermes reports) maps to the plain .map?…", () => {
		const jscSafe = "http://127.0.0.1:8081/apps/example/index.ts.bundle//&platform=ios&dev=true";
		for (const sourceMapURL of [undefined, ""]) {
			expect(jsSymbolicator.resolveMapUrl(script({ url: jscSafe, sourceMapURL }), METRO)).toEqual({
				kind: "fetch",
				url: "http://127.0.0.1:8081/apps/example/index.ts.map?platform=ios&dev=true",
			});
		}
	});

	test("a relative sourceMapURL resolves against the script url", () => {
		const r = jsSymbolicator.resolveMapUrl(script({ sourceMapURL: "/index.map?x=1" }), METRO);
		expect(r).toEqual({ kind: "fetch", url: "http://127.0.0.1:8081/index.map?x=1" });
	});

	test("the emulator alias of the host, on Metro's port, is rewritten onto Metro", () => {
		const r = jsSymbolicator.resolveMapUrl(
			script({ url: "http://10.0.2.2:8081/index.bundle", sourceMapURL: "http://10.0.2.2:8081/index.map?a=b" }),
			METRO
		);
		expect(r).toEqual({ kind: "fetch", url: "http://127.0.0.1:8081/index.map?a=b" });
	});

	test("another host is refused", () => {
		const r = jsSymbolicator.resolveMapUrl(script({ sourceMapURL: "http://169.254.169.254/latest/meta-data" }), METRO);
		expect(r.kind).toBe("refused");
	});

	test("another port on a loopback alias is refused", () => {
		expect(jsSymbolicator.resolveMapUrl(script({ sourceMapURL: "http://localhost:9999/x.map" }), METRO).kind).toBe(
			"refused"
		);
	});

	test("non-http schemes are refused", () => {
		expect(jsSymbolicator.resolveMapUrl(script({ sourceMapURL: "file:///etc/passwd" }), METRO).kind).toBe("refused");
	});

	test("a data: map is decoded locally", () => {
		const text = jsFixtures.buildSourceMap(["a.ts"], [[[0, 0, 0, 0]]]);
		const r = jsSymbolicator.resolveMapUrl(
			script({ sourceMapURL: `data:application/json;base64,${Buffer.from(text).toString("base64")}` }),
			METRO
		);
		expect(r).toEqual({ kind: "inline", text });
	});

	test("without a sourceMapURL, Metro's index.bundle -> index.map convention applies", () => {
		const r = jsSymbolicator.resolveMapUrl(script({ sourceMapURL: undefined }), METRO);
		expect(r).toEqual({ kind: "fetch", url: "http://127.0.0.1:8081/index.map?platform=ios&dev=true" });
	});

	test("a script with neither is refused", () => {
		expect(jsSymbolicator.resolveMapUrl(script({ sourceMapURL: undefined, url: "app.js" }), METRO).kind).toBe(
			"refused"
		);
	});
});

describe("scripts", () => {
	test("parseScriptParsed reads id, url and sourceMapURL", () => {
		expect(jsSymbolicator.parseScriptParsed({ scriptId: 4, url: "u", sourceMapURL: "" })).toEqual({
			scriptId: "4",
			url: "u",
			sourceMapURL: undefined,
		});
		expect(jsSymbolicator.parseScriptParsed({ url: "u" })).toBeUndefined();
	});

	test("collectScripts subscribes before Debugger.enable so the replay is seen", async () => {
		const cdp = jsFixtures.fakeCdp(
			{},
			{ "Debugger.enable": [{ scriptId: "9", url: "http://x/index.bundle", sourceMapURL: "m" }] }
		);
		const collected = await jsSymbolicator.collectScripts(cdp);
		expect([...collected.scripts.keys()]).toEqual(["9"]);
		collected.dispose();
		expect(cdp.sent.at(-1)?.method).toBe("Debugger.disable");
	});
});

describe("normalizeSource", () => {
	test("strips file:// and the project root", () => {
		expect(jsSymbolicator.normalizeSource("file:///Users/me/app/src/a.ts", "/Users/me/app")).toBe("src/a.ts");
		expect(jsSymbolicator.normalizeSource("/elsewhere/a.ts", "/Users/me/app")).toBe("/elsewhere/a.ts");
	});
});

describe("loadSourceMaps", () => {
	const map = jsFixtures.buildSourceMap(
		["/p/src/app.ts", "/p/node_modules/lodash/debounce.js"],
		[
			[[0, 0, 9, 4]],
			[
				[0, 1, 2, 0],
				[10, 0, 20, 8],
			],
		]
	);
	const scripts = new Map([["1", script()]]);
	const frame = (lineNumber: number, columnNumber: number) => ({
		functionName: "f",
		scriptId: "1",
		url: script().url,
		lineNumber,
		columnNumber,
	});

	test("maps 0-based bundle positions to original 1-based lines", async () => {
		const fetched: string[] = [];
		const maps = await jsSymbolicator.loadSourceMaps([frame(0, 0), frame(1, 12)], scripts, {
			metroUrl: METRO,
			projectRoot: "/p",
			fetchMap: async (url) => {
				fetched.push(url);
				return jsResultFactory.ok(map);
			},
		});
		expect(fetched).toHaveLength(1);
		expect(maps.loaded).toBe(1);
		expect(maps.resolve(frame(0, 0))).toMatchObject({ source: "src/app.ts", line: 10 });
		expect(maps.resolve(frame(1, 0))).toMatchObject({ source: "node_modules/lodash/debounce.js", line: 3 });
		expect(maps.resolve(frame(1, 12))).toMatchObject({ source: "src/app.ts", line: 21 });
	});

	test("a refused map is a warning and the frames stay unmapped", async () => {
		const bad = new Map([["1", script({ sourceMapURL: "http://evil.example/x.map" })]]);
		let called = false;
		const maps = await jsSymbolicator.loadSourceMaps([frame(0, 0)], bad, {
			metroUrl: METRO,
			fetchMap: async () => {
				called = true;
				return jsResultFactory.ok(map);
			},
		});
		expect(called).toBe(false);
		expect(maps.warnings[0]).toContain("not Metro");
		expect(maps.resolve(frame(0, 0)).source).toBeUndefined();
	});

	test("a failed fetch and an invalid map are warnings", async () => {
		const failed = await jsSymbolicator.loadSourceMaps([frame(0, 0)], scripts, {
			metroUrl: METRO,
			fetchMap: async () => jsResultFactory.err("too_large", "over the cap"),
		});
		expect(failed.warnings[0]).toContain("over the cap");
		const invalid = await jsSymbolicator.loadSourceMaps([frame(0, 0)], scripts, {
			metroUrl: METRO,
			fetchMap: async () => jsResultFactory.ok("not json"),
		});
		expect(invalid.warnings[0]).toContain("not a valid source map");
	});

	test("the cap is passed to the fetcher", async () => {
		let cap = 0;
		await jsSymbolicator.loadSourceMaps([frame(0, 0)], scripts, {
			metroUrl: METRO,
			fetchMap: async (_url, max) => {
				cap = max;
				return jsResultFactory.ok(map);
			},
		});
		expect(cap).toBe(MAX_SOURCE_MAP_BYTES);
		expect(MAX_SOURCE_MAP_BYTES).toBe(64 * 1024 * 1024);
	});

	test("two scripts sharing one map fetch it once", async () => {
		const two = new Map([
			["1", script()],
			["2", script({ scriptId: "2", url: "http://127.0.0.1:8081/other.bundle" })],
		]);
		let n = 0;
		await jsSymbolicator.loadSourceMaps(
			[frame(0, 0), { ...frame(0, 0), scriptId: "2", url: "http://127.0.0.1:8081/other.bundle" }],
			two,
			{
				metroUrl: METRO,
				fetchMap: async () => {
					n++;
					return jsResultFactory.ok(map);
				},
			}
		);
		expect(n).toBe(1);
	});

	test("no Metro: identity resolver and a warning", async () => {
		const maps = await jsSymbolicator.loadSourceMaps([frame(3, 4)], scripts, {
			metroUrl: undefined,
			fetchMap: async () => jsResultFactory.ok(map),
		});
		expect(maps.warnings).toHaveLength(1);
		expect(maps.resolve(frame(3, 4))).toMatchObject({ source: undefined, line: 4, column: 5 });
	});
});
