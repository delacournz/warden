import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join, relative } from "node:path";
import { openImportCache } from "./cache";
import { makeFixtureRepo } from "./fixture.testing";
import { chainTo, createImportGraph, reachable, routerLayouts } from "./graph";

let dir: string;
const rel = (files: Iterable<string>) => [...files].map((f) => relative(dir, f)).sort();

beforeEach(() => {
	dir = makeFixtureRepo().dir;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("createImportGraph", () => {
	test("ios: paths aliases, platform files, require/import(), assets, workspace source; types + externals dropped", async () => {
		const graph = await createImportGraph({ platform: "ios", repoRoot: dir });
		const reach = reachable([join(dir, "src/app/(app)/chats.tsx")], graph.imports);
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
		const chain = chainTo(reach, join(dir, "packages/ui/src/button.tsx")).map((f) => relative(dir, f));
		expect(chain).toEqual([
			"src/app/(app)/chats.tsx",
			"src/chat/list.tsx",
			"packages/ui/src/index.ts",
			"packages/ui/src/button.tsx",
		]);
	});

	test("android resolves the default file and its imports instead of the .ios one", async () => {
		const graph = await createImportGraph({ platform: "android", repoRoot: dir });
		const reach = rel(reachable([join(dir, "src/app/(app)/chats.tsx")], graph.imports).keys());
		expect(reach).toContain("src/chat/row.tsx");
		expect(reach).toContain("src/chat/android-only.tsx");
		expect(reach).not.toContain("src/chat/row.ios.tsx");
	});

	test("maxDepth: only files within N imports of an entry", async () => {
		const graph = await createImportGraph({ platform: "ios", repoRoot: dir });
		const reach = rel(reachable([join(dir, "src/app/(app)/chats.tsx")], graph.imports, 1).keys());
		expect(reach).toEqual(["src/app/(app)/chats.tsx", "src/assets/logo.png", "src/chat/list.tsx"]);
	});

	test("unparseable source falls back to the TypeScript scanner", async () => {
		const file = join(dir, "src/chat/lazy.tsx");
		await Bun.write(file, 'import "./legacy";\nconst = ;\n');
		const graph = await createImportGraph({ platform: "ios", repoRoot: dir });
		expect(rel(graph.imports(file))).toEqual(["src/chat/legacy.js"]);
	});

	test("cached specifiers are reused while the file is unchanged", async () => {
		const cache = openImportCache();
		const file = join(dir, "src/chat/list.tsx");
		cache.set(file, ["./lazy"]);
		const graph = await createImportGraph({ platform: "ios", repoRoot: dir, cache });
		expect(rel(graph.imports(file))).toEqual(["src/chat/lazy.tsx"]);
	});
});

describe("routerLayouts", () => {
	test("every _layout above a route inside the router root", () => {
		const root = join(dir, "src/app");
		expect(rel(routerLayouts(join(root, "(app)/chats.tsx"), root, "ios"))).toEqual([
			"src/app/(app)/_layout.tsx",
			"src/app/_layout.tsx",
		]);
		expect(routerLayouts(join(dir, "src/chat/list.tsx"), root, "ios")).toEqual([]);
	});
});
