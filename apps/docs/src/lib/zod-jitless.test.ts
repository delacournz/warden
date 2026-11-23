import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "zod";
import "./sidebar-title";

/**
 * The frontmatter schema ships in the browser bundle, and zod decides how a
 * schema parses when it is defined. `http-cache.ts` allows no string
 * evaluation, so zod is told to parse without it before any schema exists.
 */
describe("zod in the docs app", () => {
	test("parses without compiling code once the frontmatter schema is loaded", () => {
		expect(config().jitless).toBe(true);
	});

	test("is configured before the module that defines the first schema", () => {
		const imports = readFileSync(join(import.meta.dirname, "sidebar-title.ts"), "utf-8")
			.split("\n")
			.filter((line) => line.startsWith("import "));

		expect(imports[0]).toBe('import "./zod-jitless";');
	});

	/** The package is otherwise side-effect free, and a bundler drops an import that is only for its effect. */
	test("is a module the bundler is told to keep", () => {
		const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf-8")) as {
			sideEffects?: boolean | string[];
		};

		expect(manifest.sideEffects).toEqual(["./src/lib/zod-jitless.ts"]);
	});
});
