import { describe, expect, test } from "bun:test";
import { buildClusterGraph, clusterOf, findCycles, importSpecifiers, mutualPairs } from "./cycles";

describe("mutualPairs", () => {
	test("lists two-way edges once", () => {
		const g = new Map([
			["a", new Set(["b", "c"])],
			["b", new Set(["a"])],
			["c", new Set<string>()],
		]);
		expect(mutualPairs(g)).toEqual(["a <-> b"]);
	});
});

describe("clusterOf", () => {
	test("top-level subdir is its own cluster, top-level file is root", () => {
		expect(clusterOf("builds/install.ts")).toBe("builds");
		expect(clusterOf("config/a/b.ts")).toBe("config");
		expect(clusterOf("store.ts")).toBe("root");
	});
});

describe("importSpecifiers", () => {
	test("static, type, side-effect, dynamic and require forms", () => {
		const src = [
			`import a from "./a";`,
			`import type { B } from "../b";`,
			`export { c } from "./c";`,
			`import "./d";`,
			`const e = await import("./e");`,
			`const f = require("./f") as typeof import("./f");`,
			`import z from "zod";`,
		].join("\n");
		expect(importSpecifiers(src).sort()).toEqual(["../b", "./a", "./c", "./d", "./e", "./f", "zod"]);
	});
});

describe("importSpecifiers comments", () => {
	test("ignores specifiers inside block and line comments", () => {
		const src = `/** import x from "./doc" */\n// import y from "./line"\nimport z from "./real"; // from "./trail"`;
		expect(importSpecifiers(src)).toEqual(["./real"]);
	});
});

describe("buildClusterGraph", () => {
	const files = new Map<string, string>([
		["a/x.ts", `import { y } from "../b/y";`],
		["b/y.ts", `import { x } from "../a/x";`],
		["c/z.ts", `import { s } from "../store"; import { y } from "../b/y"; import { l } from "./local";`],
		["c/local.ts", ""],
		["store.ts", `import { x } from "./a/x";`],
		["a/x.test.ts", `import { z } from "../c/z";`],
	]);
	test("cluster edges ignore root, tests, self and externals", () => {
		const g = buildClusterGraph(files);
		expect([...(g.get("a") ?? [])]).toEqual(["b"]);
		expect([...(g.get("b") ?? [])]).toEqual(["a"]);
		expect([...(g.get("c") ?? [])]).toEqual(["b"]);
		expect(g.has("root")).toBe(false);
	});
	test("findCycles reports strongly connected clusters only", () => {
		expect(findCycles(buildClusterGraph(files))).toEqual([["a", "b"]]);
	});
	test("acyclic graph has none", () => {
		expect(
			findCycles(
				new Map([
					["a", new Set(["b"])],
					["b", new Set<string>()],
				])
			)
		).toEqual([]);
	});
});
