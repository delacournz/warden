import { describe, expect, test } from "bun:test";
import { importSpecifiers } from "./cycles";
import {
	declaredGraph,
	importedGraph,
	packageCycles,
	undeclaredImports,
	type WorkspacePackage,
	workspacePackageOf,
} from "./packages";

const pkg = (name: string, declared: string[], files: Record<string, string> = {}): WorkspacePackage => ({
	name,
	declared,
	sources: new Map(Object.entries(files)),
});

describe("workspacePackageOf", () => {
	test("maps a subpath import to its package", () => {
		expect(workspacePackageOf("@delacour/warden-store/types")).toBe("@delacour/warden-store");
		expect(workspacePackageOf("@delacour/warden")).toBe("@delacour/warden");
		expect(workspacePackageOf("@delacour/warden/config")).toBe("@delacour/warden");
	});
	test("ignores everything else", () => {
		expect(workspacePackageOf("zod")).toBeUndefined();
		expect(workspacePackageOf("@delacour/other")).toBeUndefined();
	});
});

describe("package graphs", () => {
	const a = pkg("@delacour/warden-a", ["@delacour/warden-b", "zod"], {
		"a.ts": `import { x } from "@delacour/warden-b/x";\nimport { c } from "@delacour/warden-c/c";`,
	});
	const b = pkg("@delacour/warden-b", [], {});
	const c = pkg("@delacour/warden-c", ["@delacour/warden-a"], { "c.ts": `import "@delacour/warden-a/a";` });

	test("declared edges keep workspace packages only", () => {
		const g = declaredGraph([a, b, c]);
		expect([...(g.get(a.name) ?? [])]).toEqual(["@delacour/warden-b"]);
	});

	test("imported edges are read from sources", () => {
		const g = importedGraph([a, b, c], importSpecifiers);
		expect([...(g.get(a.name) ?? [])].sort()).toEqual(["@delacour/warden-b", "@delacour/warden-c"]);
	});

	test("undeclared imports are reported", () => {
		const declared = declaredGraph([a, b, c]);
		const imported = importedGraph([a, b, c], importSpecifiers);
		expect(undeclaredImports(imported, declared)).toEqual(["@delacour/warden-a -> @delacour/warden-c"]);
	});

	test("a cross-package cycle is found", () => {
		const g = importedGraph([a, b, c], importSpecifiers);
		expect(packageCycles(g)).toEqual([["@delacour/warden-a", "@delacour/warden-c"]]);
	});

	test("an acyclic graph has none", () => {
		expect(packageCycles(declaredGraph([a, b]))).toEqual([]);
	});
});
