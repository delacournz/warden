import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { addEsmExtensions, emitDeclarations, entryDeclaration, rewriteWorkspaceSpecifiers } from "./declarations";

const TYPES = "/out/types";

describe("rewriteWorkspaceSpecifiers", () => {
	test("workspace specifiers become relative paths into the emitted tree", () => {
		const file = `${TYPES}/e2e/src/driver/open.d.ts`;
		const text =
			'import type { Result } from "@delacour/warden-types/result";\nimport { x } from "@delacour/warden-providers/ios";\n';
		expect(rewriteWorkspaceSpecifiers(text, file, TYPES)).toBe(
			'import type { Result } from "../../../types/src/result";\nimport { x } from "../../../providers/src/ios";\n'
		);
	});

	test("same-directory targets get ./, `import()` types and single quotes are handled, others untouched", () => {
		const file = `${TYPES}/e2e/src/a.d.ts`;
		expect(rewriteWorkspaceSpecifiers("import('@delacour/warden-e2e/b').B", file, TYPES)).toBe("import('./b').B");
		const untouched = 'import { z } from "zod";\nimport "bun:test";\nimport "@delacour/warden-other/x";\n';
		expect(rewriteWorkspaceSpecifiers(untouched, file, TYPES)).toBe(untouched);
	});
});

describe("addEsmExtensions", () => {
	const present = new Set(["/t/a/b.d.ts", "/t/a/dir/index.d.ts", "/t/c/x.schema.d.ts"]);
	const exists = (path: string) => present.has(path);
	const file = "/t/a/main.d.ts";

	test("a file becomes ./b.js, a directory ./dir/index.js, a dotted name keeps its dot", () => {
		const text =
			'import { B } from "./b";\nexport * from "./dir";\nexport type { X } from "../c/x.schema";\nlet y: import("./b").B;\n';
		expect(addEsmExtensions(text, file, exists)).toBe(
			'import { B } from "./b.js";\nexport * from "./dir/index.js";\nexport type { X } from "../c/x.schema.js";\nlet y: import("./b.js").B;\n'
		);
	});

	test("extensions, bare specifiers and unresolvable paths are left alone", () => {
		const text = 'import "./b.js";\nimport "zod";\nimport "./missing";\nimport d from "./d.json";\n';
		expect(addEsmExtensions(text, file, exists)).toBe(text);
	});
});

describe("entryDeclaration", () => {
	test("re-exports the emitted module", () => {
		expect(entryDeclaration("types", "e2e/src/index.ts")).toBe('export * from "./types/e2e/src/index";\n');
	});
});

describe("emitDeclarations (the real packages/e2e)", () => {
	const packages = resolve(import.meta.dir, "../../../../packages");
	let out: string;
	beforeEach(() => {
		out = mkdtempSync(join(tmpdir(), "warden-dts-"));
	});
	afterEach(() => rmSync(out, { recursive: true, force: true }));

	function allFiles(dir: string): string[] {
		return readdirSync(dir).flatMap((name) => {
			const path = join(dir, name);
			return statSync(path).isDirectory() ? allFiles(path) : [path];
		});
	}

	test("index + preload declarations, no bare workspace specifier left", () => {
		const written = emitDeclarations({
			tsconfigPath: join(packages, "e2e", "tsconfig.json"),
			entries: [join(packages, "e2e/src/index.ts"), join(packages, "e2e/src/preload.ts")],
			packagesDir: packages,
			outDir: out,
		});
		if (!written.success) throw new Error(written.error);
		expect(existsSync(join(out, "e2e/src/index.d.ts"))).toBe(true);
		expect(existsSync(join(out, "e2e/src/preload.d.ts"))).toBe(true);
		expect(readFileSync(join(out, "e2e/src/index.d.ts"), "utf8")).toContain("WARDEN_E2E_VERSION");
		for (const file of allFiles(out)) {
			expect(readFileSync(file, "utf8")).not.toMatch(/(?:from |import\()\s*["']@delacour\/warden-/);
		}
	}, 60_000);

	test("every relative import in the emitted tree points at an emitted declaration (workspace packages included)", () => {
		const written = emitDeclarations({
			tsconfigPath: join(packages, "e2e", "tsconfig.json"),
			entries: [join(packages, "e2e/src/index.ts"), join(packages, "e2e/src/preload.ts")],
			packagesDir: packages,
			outDir: out,
		});
		if (!written.success) throw new Error(written.error);
		expect(existsSync(join(out, "types/src/result.d.ts"))).toBe(true);
		const missing: string[] = [];
		for (const file of allFiles(out)) {
			const text = readFileSync(file, "utf8");
			for (const match of text.matchAll(/(?:from |import\()\s*["'](\.[^"']*)["']/g)) {
				const target = resolve(dirname(file), match[1] ?? "");
				if (!existsSync(`${target}.d.ts`) && !existsSync(join(target, "index.d.ts")))
					missing.push(`${file} -> ${match[1]}`);
			}
		}
		expect(missing).toEqual([]);
	}, 60_000);
});
