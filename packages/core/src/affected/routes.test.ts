import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { routeResolver } from "./routes";
import { specScanner } from "./specs";

let dir: string;
const touch = (path: string) => {
	mkdirSync(dirname(join(dir, path)), { recursive: true });
	writeFileSync(join(dir, path), "export {};\n");
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-routes-"));
	for (const file of [
		"src/app/index.tsx",
		"src/app/welcome.tsx",
		"src/app/(tabs)/todos.tsx",
		"src/app/(tabs)/settings/index.tsx",
		"src/app/todo/[id].tsx",
		"src/app/about.ios.tsx",
		"src/app/about.tsx",
	]) {
		touch(file);
	}
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const root = () => join(dir, "src/app");

describe("routeFile", () => {
	test("a file, a directory index, a dynamic segment and the root", () => {
		expect(routeResolver.file("(tabs)/todos", root(), "ios")).toBe(join(root(), "(tabs)/todos.tsx"));
		expect(routeResolver.file("(tabs)/settings", root(), "ios")).toBe(join(root(), "(tabs)/settings/index.tsx"));
		expect(routeResolver.file("todo/[id]", root(), "ios")).toBe(join(root(), "todo/[id].tsx"));
		expect(routeResolver.file("index", root(), "ios")).toBe(join(root(), "index.tsx"));
		expect(routeResolver.file("/", root(), "ios")).toBe(join(root(), "index.tsx"));
	});

	test("a platform variant wins on its platform", () => {
		expect(routeResolver.file("about", root(), "ios")).toBe(join(root(), "about.ios.tsx"));
		expect(routeResolver.file("about", root(), "android")).toBe(join(root(), "about.tsx"));
	});

	test("an unknown route has no file", () => {
		expect(routeResolver.file("nope", root(), "ios")).toBeUndefined();
	});
});

describe("routeEntries", () => {
	test("config-dir relative, deduplicated, unresolved routes listed apart", () => {
		const result = routeResolver.entries(["welcome", "(tabs)/todos", "welcome", "ghost"], root(), dir, "ios");
		expect(result.entries).toEqual(["src/app/welcome.tsx", "src/app/(tabs)/todos.tsx"]);
		expect(result.unresolved).toEqual(["ghost"]);
	});
});

describe("specIdOf", () => {
	test("the path below specsDir without the spec extension", () => {
		expect(specScanner.idOf("/p/e2e/sign-in.e2e.ts", "/p/e2e")).toBe("sign-in");
		expect(specScanner.idOf("/p/e2e/qa/login.e2e.tsx", "/p/e2e")).toBe("qa/login");
	});
});
