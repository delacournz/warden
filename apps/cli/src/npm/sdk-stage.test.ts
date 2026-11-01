import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { processExec } from "@delacour/warden-runtime/exec";
import { SDK_ENTRIES } from "./manifests";
import { sdkDependencies } from "./sdk-stage";

describe("sdkDependencies", () => {
	const json = (value: unknown) => JSON.stringify(value);

	test("zod keeps the range packages/sdk declares; ai is the peer range", () => {
		expect(
			sdkDependencies(
				json({ dependencies: { zod: "^4.4.3", typescript: "^5.9.3" }, peerDependencies: { ai: ">=7 <8" } })
			)
		).toEqual({ success: true, data: { dependencies: { zod: "^4.4.3" }, aiRange: ">=7 <8" } });
	});

	test("an external the package does not declare is an error", () => {
		const noZod = sdkDependencies(json({ dependencies: {}, peerDependencies: { ai: ">=7 <8" } }));
		expect(noZod.success).toBe(false);
		if (!noZod.success) expect(noZod.error).toContain("no dependency zod");
		const noAi = sdkDependencies(json({ dependencies: { zod: "^4.4.3" } }));
		expect(noAi.success).toBe(false);
		if (!noAi.success) expect(noAi.error).toContain("peerDependencies.ai");
	});
});

const CLI = resolve(import.meta.dir, "../..");
const REPO = resolve(CLI, "../..");
const BIN = join(REPO, "node_modules", ".bin");
/** Bun writes node built-ins without the `node:` prefix. */
const BUILTINS = new Set([
	"fs",
	"fs/promises",
	"path",
	"os",
	"crypto",
	"async_hooks",
	"net",
	"child_process",
	"module",
]);
const BARE_IMPORT = /^(?:import\s.*?\sfrom|\}\s*from|import|export\s.*?\sfrom)\s*"([^."/][^"]*)";?$/gm;

function filesUnder(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? filesUnder(path) : [path];
	});
}

/** One real staging of packages/sdk (a child process: `Bun.build` inside `bun test` mis-resolves already loaded workspace files). */
describe("stageSdk (the real packages/sdk)", () => {
	let out: string;
	let pkg: string;
	beforeAll(async () => {
		out = mkdtempSync(join(tmpdir(), "warden-sdk-stage-"));
		const staged = await processExec.run(["bun", join(CLI, "scripts/npm-packages.ts"), "--sdk-only", "--out", out]);
		if (staged.exitCode !== 0) throw new Error(staged.stderr || staged.stdout);
		pkg = join(out, "warden-sdk");
	}, 120_000);
	afterAll(() => rmSync(out, { recursive: true, force: true }));

	test("every export has its bundle and declaration, and nothing internal is exported", () => {
		const manifest: { exports: Record<string, unknown> } = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
		expect(Object.keys(manifest.exports)).toEqual([...Object.keys(SDK_ENTRIES), "./package.json"]);
		for (const entry of Object.values(SDK_ENTRIES)) {
			expect(statSync(join(pkg, entry.js)).isFile()).toBe(true);
			expect(statSync(join(pkg, entry.types)).isFile()).toBe(true);
		}
		expect(JSON.stringify(manifest)).not.toContain("lease-view");
	});

	test("bundle-safe: the only bare imports are built-ins, bun:*, zod and ai; no @delacour/* specifier anywhere", () => {
		const imports = new Set<string>();
		for (const file of filesUnder(pkg).filter((f) => /\.(mjs|d\.ts)$/.test(f))) {
			const text = readFileSync(file, "utf8");
			for (const match of text.matchAll(BARE_IMPORT)) imports.add(match[1] ?? "");
		}
		const thirdParty = [...imports].filter(
			(name) => !BUILTINS.has(name) && !name.startsWith("node:") && !name.startsWith("bun:")
		);
		expect(thirdParty.sort()).toEqual(["ai", "zod"]);
	});

	test("publint is clean", async () => {
		const result = await processExec.run([join(BIN, "publint"), "--strict", pkg]);
		expect(result.stdout + result.stderr).toContain("All good!");
		expect(result.exitCode).toBe(0);
	}, 120_000);

	test("are-the-types-wrong is clean for an ESM-only, Bun-only package (node16 ESM + bundler)", async () => {
		const result = await processExec.run([join(BIN, "attw"), "--pack", pkg, "--profile", "esm-only"]);
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
	}, 120_000);
});
