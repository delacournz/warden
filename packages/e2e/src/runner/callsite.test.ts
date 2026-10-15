import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { callerFile } from "./callsite";

const own = (name: string): string => join(import.meta.dir, name);

describe("callerFile", () => {
	test("skips the runner's own frames and returns the spec", () => {
		const stack = [
			"Error",
			`    at callerFile (${own("callsite.ts")}:13:60)`,
			`    at registerTest (${own("test.ts")}:73:15)`,
			`    at <anonymous> (${own("test.ts")}:150:3)`,
			"    at <anonymous> (/app/e2e/login.e2e.ts:12:3)",
			"    at loadModule (/app/node_modules/bun/runner.js:1:1)",
		].join("\n");
		expect(callerFile(stack)).toBe("/app/e2e/login.e2e.ts");
	});

	test("understands bun's module-level frame without a column", () => {
		const stack = `Error\n    at registerTest (${own("test.ts")}:73:15)\n    at /app/e2e/a.e2e.ts:5`;
		expect(callerFile(stack)).toBe("/app/e2e/a.e2e.ts");
	});

	test("understands frames without a function name and file:// urls", () => {
		expect(callerFile("Error\n    at /app/e2e/b.e2e.ts:7:1")).toBe("/app/e2e/b.e2e.ts");
		expect(callerFile("Error\n    at f (file:///app/e2e/c.e2e.ts:7:1)")).toBe("/app/e2e/c.e2e.ts");
	});

	test("skips node_modules and the package entry", () => {
		const stack = [
			"Error",
			`    at x (${join(import.meta.dir, "..", "index.ts")}:1:1)`,
			"    at y (/app/node_modules/dep/index.js:1:1)",
			"    at /app/e2e/d.e2e.ts:3:1",
		].join("\n");
		expect(callerFile(stack)).toBe("/app/e2e/d.e2e.ts");
	});

	test("unknown when nothing matches", () => {
		expect(callerFile("Error")).toBe("unknown");
		expect(callerFile(undefined)).not.toBe("");
	});
});
