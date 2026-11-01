import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fixtureRepos } from "../testing/fixture.testing";
import { importCaches } from "./cache";
import { importGraphs, TYPESCRIPT_MISSING, typescriptResolver } from "./graph";

let dir: string;
const rel = (files: Iterable<string>) => [...files].map((f) => relative(dir, f)).sort();

beforeEach(() => {
	dir = fixtureRepos.create().dir;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("createImportGraph", () => {
	test("ios: paths aliases, platform files, require/import(), assets, workspace source; types + externals dropped", async () => {
		const graph = await fixtureRepos.graphOf({ platform: "ios", repoRoot: dir });
		const reach = importGraphs.reachable([join(dir, "src/app/(app)/chats.tsx")], graph.imports);
		expect(rel(reach.keys())).toEqual([
			"packages/ui/src/button.tsx",
			"packages/ui/src/index.ts",
			"src/app/(app)/chats.tsx",
			"src/assets/logo.png",
			"src/chat/lazy.tsx",
			"src/chat/legacy.js",
			"src/chat/list.tsx",
			"src/chat/row.ios.tsx",
		]);
		const chain = importGraphs.chainTo(reach, join(dir, "packages/ui/src/button.tsx")).map((f) => relative(dir, f));
		expect(chain).toEqual([
			"src/app/(app)/chats.tsx",
			"src/chat/list.tsx",
			"packages/ui/src/index.ts",
			"packages/ui/src/button.tsx",
		]);
	});

	test("android resolves the default file and its imports instead of the .ios one", async () => {
		const graph = await fixtureRepos.graphOf({ platform: "android", repoRoot: dir });
		const reach = rel(importGraphs.reachable([join(dir, "src/app/(app)/chats.tsx")], graph.imports).keys());
		expect(reach).toContain("src/chat/row.tsx");
		expect(reach).toContain("src/chat/android-only.tsx");
		expect(reach).not.toContain("src/chat/row.ios.tsx");
	});

	test("maxDepth: only files within N imports of an entry", async () => {
		const graph = await fixtureRepos.graphOf({ platform: "ios", repoRoot: dir });
		const reach = rel(importGraphs.reachable([join(dir, "src/app/(app)/chats.tsx")], graph.imports, 1).keys());
		expect(reach).toEqual(["src/app/(app)/chats.tsx", "src/assets/logo.png", "src/chat/list.tsx"]);
	});

	test("unparseable source falls back to the TypeScript scanner", async () => {
		const file = join(dir, "src/chat/lazy.tsx");
		await Bun.write(file, 'import "./legacy";\nconst = ;\n');
		const graph = await fixtureRepos.graphOf({ platform: "ios", repoRoot: dir });
		expect(rel(graph.imports(file))).toEqual(["src/chat/legacy.js"]);
	});

	test("cached specifiers are reused while the file is unchanged", async () => {
		const cache = importCaches.open();
		const file = join(dir, "src/chat/list.tsx");
		cache.set(file, ["./lazy"]);
		const graph = await fixtureRepos.graphOf({ platform: "ios", repoRoot: dir, cache });
		expect(rel(graph.imports(file))).toEqual(["src/chat/lazy.tsx"]);
	});
});

/** `<root>/node_modules/typescript` whose index.js is `source`, with `version` in its package.json when given. */
function stubTypescript(root: string, source: string, version?: string): string {
	const pkgDir = join(root, "node_modules", "typescript");
	mkdirSync(pkgDir, { recursive: true });
	writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "typescript", ...(version ? { version } : {}) }));
	writeFileSync(join(pkgDir, "index.js"), source);
	return join(pkgDir, "index.js");
}

describe("createImportGraph: the compiler it loads (cli-size-R1, R3, R4, R8)", () => {
	const projectOnly = (root: string) => typescriptResolver.resolve(root, () => undefined);
	const API = [
		"preProcessFile",
		"resolveModuleName",
		"getParsedCommandLineOfConfigFile",
		"createModuleResolutionCache",
	];
	const fakeTs = (versionMajorMinor: string, missing = "") =>
		`module.exports = { versionMajorMinor: ${JSON.stringify(versionMajorMinor)}, ${API.filter((f) => f !== missing)
			.map((f) => `${f}: () => undefined`)
			.join(", ")} };\n`;

	test("a typescript without the compiler API is an error naming its version and path, not a TypeError", async () => {
		const path = stubTypescript(dir, fakeTs("5.9", "resolveModuleName"));
		const res = await importGraphs.create({ platform: "ios", repoRoot: dir, typescript: projectOnly });
		expect(res.success).toBe(false);
		if (res.success) return;
		expect(res.error).toContain(path);
		expect(res.error).toContain("5.9");
		expect(res.error).toContain("resolveModuleName");
	});

	test("an empty module is no compiler either", async () => {
		const path = stubTypescript(dir, "module.exports = {};\n");
		const res = await importGraphs.create({ platform: "ios", repoRoot: dir, typescript: projectOnly });
		expect(res).toMatchObject({ success: false });
		if (!res.success) expect(res.error).toContain(path);
	});

	test("typescript older than 5.0 (no moduleSuffixes / Bundler resolution) is an error naming the version", async () => {
		const path = stubTypescript(dir, fakeTs("4.6"));
		const res = await importGraphs.create({ platform: "ios", repoRoot: dir, typescript: projectOnly });
		expect(res.success).toBe(false);
		if (res.success) return;
		expect(res.error).toContain("typescript 4.6");
		expect(res.error).toContain(path);
		expect(res.error).toContain("5.0");
	});

	test("none: the error says what is missing, where it looked, and has no `warden affected` prefix of its own", async () => {
		const res = await importGraphs.create({ platform: "ios", repoRoot: dir, typescript: () => undefined });
		expect(res.success).toBe(false);
		if (res.success) return;
		expect(res.error).toStartWith(TYPESCRIPT_MISSING);
		expect(res.error).toStartWith("needs typescript in the analysed project");
		expect(res.error).toContain(join("node_modules", "typescript"));
		expect(res.error).toContain(dir);
	});

	test("a project typescript that re-exports the real compiler builds the same graph", async () => {
		const real = Bun.resolveSync("typescript", import.meta.dir);
		stubTypescript(dir, `module.exports = require(${JSON.stringify(real)});\n`);
		const res = await importGraphs.create({ platform: "ios", repoRoot: dir, typescript: projectOnly });
		if (!res.success) throw new Error(res.error);
		const want = await importGraphs.create({ platform: "ios", repoRoot: dir });
		if (!want.success) throw new Error(want.error);
		const entry = join(dir, "src/app/(app)/chats.tsx");
		expect([...importGraphs.reachable([entry], res.data.imports)]).toEqual([
			...importGraphs.reachable([entry], want.data.imports),
		]);
		expect(rel(importGraphs.reachable([entry], res.data.imports).keys())).toContain("src/chat/row.ios.tsx");
	});
});

describe("typescriptVersionProblem (no import: read from its package.json)", () => {
	test("older than 5.0 is a problem naming the version and path; 5.x, 6.x and unknown are not", () => {
		const path = stubTypescript(dir, "", "4.9.5");
		expect(typescriptResolver.versionProblem(path)).toContain("typescript 4.9.5");
		expect(typescriptResolver.versionProblem(path)).toContain(path);
		expect(typescriptResolver.versionProblem(stubTypescript(dir, "", "5.0.4"))).toBeUndefined();
		expect(typescriptResolver.versionProblem(stubTypescript(dir, "", "6.0.3"))).toBeUndefined();
		expect(typescriptResolver.versionProblem(stubTypescript(dir, ""))).toBeUndefined();
		expect(typescriptResolver.versionProblem("/nowhere/typescript/index.js")).toBeUndefined();
	});
});

describe("routerLayouts", () => {
	test("every _layout above a route inside the router root", () => {
		const root = join(dir, "src/app");
		expect(rel(importGraphs.routerLayouts(join(root, "(app)/chats.tsx"), root, "ios"))).toEqual([
			"src/app/(app)/_layout.tsx",
			"src/app/_layout.tsx",
		]);
		expect(importGraphs.routerLayouts(join(dir, "src/chat/list.tsx"), root, "ios")).toEqual([]);
	});
});

describe("resolveTypescript", () => {
	const none = () => undefined;

	test("without warden's own (a compiled binary): the analysed project's, from its root upward", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "warden-ts-")));
		try {
			mkdirSync(join(root, "node_modules", "typescript", "lib"), { recursive: true });
			writeFileSync(
				join(root, "node_modules", "typescript", "package.json"),
				JSON.stringify({ name: "typescript", main: "./lib/typescript.js" })
			);
			writeFileSync(join(root, "node_modules", "typescript", "lib", "typescript.js"), "module.exports = {};\n");
			mkdirSync(join(root, "apps", "mobile"), { recursive: true });
			const expected = join(root, "node_modules", "typescript", "lib", "typescript.js");
			expect(typescriptResolver.resolve(root, none)).toBe(expected);
			expect(typescriptResolver.resolve(join(root, "apps", "mobile"), none)).toBe(expected);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a package without `main` resolves to its index.js; a dangling directory is not a compiler", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "warden-ts-")));
		try {
			mkdirSync(join(root, "node_modules", "typescript"), { recursive: true });
			expect(typescriptResolver.resolve(root, none)).toBeUndefined();
			writeFileSync(join(root, "node_modules", "typescript", "package.json"), "{}");
			writeFileSync(join(root, "node_modules", "typescript", "index.js"), "module.exports = {};\n");
			expect(typescriptResolver.resolve(root, none)).toBe(join(root, "node_modules", "typescript", "index.js"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a compiled binary resolves no packages itself: the lookup reads node_modules, not the runtime resolver", () => {
		const source = readFileSync(join(import.meta.dir, "graph.ts"), "utf8");
		const lookup = source.slice(source.indexOf("\tresolve(repoRoot: string"));
		expect(lookup.slice(0, lookup.indexOf("\n\t}\n"))).not.toMatch(/createRequire|resolveSync|require\.resolve/);
	});

	test("warden's own typescript wins when it resolves (source mode), even over the project's (cli-size-R2)", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "warden-ts-")));
		try {
			stubTypescript(root, "module.exports = {};\n");
			expect(typescriptResolver.resolve(root, () => "/warden/node_modules/typescript/lib/typescript.js")).toBe(
				"/warden/node_modules/typescript/lib/typescript.js"
			);
			expect(typescriptResolver.resolve(root, none)).toBe(join(root, "node_modules", "typescript", "index.js"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a project without typescript uses the one beside warden (source mode)", () => {
		expect(typescriptResolver.resolve(dir, () => "/warden/node_modules/typescript/lib/typescript.js")).toBe(
			"/warden/node_modules/typescript/lib/typescript.js"
		);
		expect(typescriptResolver.resolve(dir)).toEndWith(join("typescript", "lib", "typescript.js"));
	});

	test("neither: undefined (a compiled binary leaves typescript out)", () => {
		expect(typescriptResolver.resolve(dir, none)).toBeUndefined();
	});
});
