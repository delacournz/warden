import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { bunExec } from "../exec";
import { graphOf, makeFixtureRepo } from "./fixture.testing";
import { reachable, TYPESCRIPT_MISSING } from "./graph";
import { importsOfDoc, parseGraphDoc } from "./graph-snapshot";
import { buildGraphDoc } from "./graph-worker";

const WORKER = join(import.meta.dir, "graph-worker.ts");

let dir: string;
beforeEach(() => {
	dir = makeFixtureRepo().dir;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("buildGraphDoc", () => {
	test("the table of everything reachable from the entries answers like the graph it was walked with", async () => {
		const entries = [join(dir, "src/app/(app)/chats.tsx"), join(dir, "src/app/(app)/settings.tsx")];
		const built = await buildGraphDoc({ platform: "ios", repoRoot: dir, entries });
		if (!built.success) throw new Error(built.error);
		const doc = built.data;
		const graph = await graphOf({ platform: "ios", repoRoot: dir });
		const want = reachable(entries, graph.imports);
		expect(doc.files.slice().sort()).toEqual([...want.keys()].sort());
		const imports = importsOfDoc(doc);
		for (const file of want.keys()) expect(imports(file)).toEqual(graph.imports(file));
		expect([...reachable(entries, imports)]).toEqual([...want]);
	});

	test("the specifier cache is read and updated through importCachePath", async () => {
		const importCachePath = join(dir, ".cache", "imports.json");
		await buildGraphDoc({
			platform: "ios",
			repoRoot: dir,
			entries: [join(dir, "src/app/(app)/chats.tsx")],
			importCachePath,
		});
		const cached = JSON.parse(readFileSync(importCachePath, "utf8")) as { files: Record<string, unknown> };
		expect(Object.keys(cached.files)).toContain(join(dir, "src/chat/list.tsx"));
	});
});

describe("buildGraphDoc without a usable compiler (cli-size-R5)", () => {
	test("is an error Result, not a throw", async () => {
		const res = await buildGraphDoc({ platform: "ios", repoRoot: dir, entries: [] }, () => undefined);
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toStartWith(TYPESCRIPT_MISSING);
	});
});

describe("graph-worker.ts as a script", () => {
	test("prints the table for the request in argv", async () => {
		const request = { platform: "android", repoRoot: dir, entries: [join(dir, "src/app/(app)/chats.tsx")] };
		const res = await bunExec([process.execPath, WORKER, JSON.stringify(request)], { cwd: dir });
		expect(res.exitCode).toBe(0);
		const doc = parseGraphDoc(res.stdout);
		expect(doc?.files).toContain(join(dir, "src/chat/android-only.tsx"));
		expect(doc?.files).not.toContain(join(dir, "src/chat/row.ios.tsx"));
	});

	test("a request that is not one fails", async () => {
		const res = await bunExec([process.execPath, WORKER, '{"platform":"web"}'], { cwd: dir });
		expect(res.exitCode).not.toBe(0);
		expect(res.stdout).toBe("");
	});
});

describe("the compiler stays out of this process", () => {
	/** `typescript` imports that run when a module loads: `import type` and `import("typescript")` do not */
	function evaluatedAtLoad(file: string): boolean {
		const imports = new Bun.Transpiler({ loader: "ts" }).scanImports(readFileSync(join(import.meta.dir, file), "utf8"));
		return imports.some((i) => i.path === "typescript" && i.kind !== "dynamic-import");
	}

	test("nothing the affected command imports evaluates typescript at load", () => {
		const modules = readdirSync(import.meta.dir).filter((f) => f.endsWith(".ts") && !/\.(test|testing)\.ts$/.test(f));
		expect(modules).toContain("graph.ts");
		expect(modules.filter(evaluatedAtLoad)).toEqual([]);
	});

	test("graph.ts loads it on the first graph from a resolved path, so no bundle follows a `typescript` import", () => {
		const source = readFileSync(join(import.meta.dir, "graph.ts"), "utf8");
		const imports = new Bun.Transpiler({ loader: "ts" }).scanImports(source);
		expect(imports.filter((i) => i.path === "typescript").map((i) => i.kind)).toEqual([]);
		expect(source).toContain("await import(path)");
	});
});
