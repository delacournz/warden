import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bunExec } from "@delacour/warden-core/exec";

/** Bun writes node built-ins without the `node:` prefix. */
const BUILTINS = new Set(["fs", "fs/promises", "path", "os", "crypto", "async_hooks"]);
/** Top-level `import … from "x"` / `} from "x"` / `import "x"` statements (not strings that merely contain the words). */
const BARE_IMPORT = /^(?:import\s.*?\sfrom|\}\s*from|import)\s*"([^."/][^"]*)";$/gm;
const MAIN = resolve(import.meta.dir, "e2e-bundle-main.ts");
const SRC = resolve(import.meta.dir, "../../../../packages/e2e/src");

describe("bundleE2e (the real packages/e2e)", () => {
	let out: string;
	beforeEach(() => {
		out = mkdtempSync(join(tmpdir(), "warden-e2e-bundle-"));
	});
	afterEach(() => rmSync(out, { recursive: true, force: true }));

	/** In a child process: `Bun.build` inside `bun test` mis-resolves files the test process already loaded. */
	async function bundle(version: string): Promise<void> {
		const result = await bunExec(["bun", MAIN, SRC, out, version]);
		if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
	}

	test("index.mjs + preload.mjs; the only bare imports left are built-ins and zod", async () => {
		await bundle("9.8.7");
		const files = readdirSync(out);
		expect(files).toContain("index.mjs");
		expect(files).toContain("preload.mjs");

		const imports = new Set<string>();
		for (const file of files) {
			for (const match of readFileSync(join(out, file), "utf8").matchAll(BARE_IMPORT)) imports.add(match[1] ?? "");
		}
		const thirdParty = [...imports].filter(
			(name) => !BUILTINS.has(name) && !name.startsWith("node:") && !name.startsWith("bun:")
		);
		expect(thirdParty).toEqual(["zod"]);
		expect(imports.has("bun:test")).toBe(true);
	}, 60_000);

	test("the entries share one chunk (a single session module) and WARDEN_E2E_VERSION is the published version", async () => {
		await bundle("9.8.7");
		const files = readdirSync(out);
		expect(files.filter((name) => name.startsWith("chunk-"))).toHaveLength(1);
		const chunk = files.find((name) => name.startsWith("chunk-")) ?? "";
		expect(readFileSync(join(out, chunk), "utf8")).toContain('"9.8.7"');
		const imported = (file: string) => readFileSync(join(out, file), "utf8").match(/from\s*"(\.\/chunk-[^"]+)"/)?.[1];
		expect(imported("index.mjs")).toBeDefined();
		expect(imported("index.mjs")).toBe(imported("preload.mjs"));
	}, 60_000);
});
