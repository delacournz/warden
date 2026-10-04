import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { buildConfigEntry } from "./config-entry";
import { CONFIG_ENTRY_DTS, CONFIG_ENTRY_JS, mainManifest } from "./manifests";

let dir: string;
let pkg: string;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "warden-config-entry-"));
	pkg = join(dir, "node_modules", "@delacour", "warden");
	mkdirSync(pkg, { recursive: true });
	writeFileSync(
		join(pkg, "package.json"),
		JSON.stringify(mainManifest({ version: "0.0.0", description: "", license: "MIT" }))
	);
	const res = await buildConfigEntry(pkg);
	if (!res.success) throw new Error(res.error);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Typecheck `source` as a consumer's `warden.config.ts`, resolving `@delacour/warden/config` like node does. */
function diagnose(source: string): string[] {
	const file = join(dir, "warden.config.ts");
	writeFileSync(file, source);
	writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
	const program = ts.createProgram([file], {
		strict: true,
		noEmit: true,
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.Node16,
		moduleResolution: ts.ModuleResolutionKind.Node16,
		types: [],
	});
	return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("buildConfigEntry", () => {
	test("a consumer config typechecks under node16 resolution", () => {
		expect(
			diagnose(`import { defineConfig, type WardenConfig } from "@delacour/warden/config";
const shared: WardenConfig["batches"] = { smoke: { platform: "ios", cmd: ["true"] } };
export default defineConfig(({ env }) => ({
	projects: [{ name: "app", bundleId: { ios: env.IOS_BUNDLE_ID ?? "com.x.app" }, build: { configuration: "Release" } }],
	batches: shared,
}));`)
		).toEqual([]);
	});

	test("typos and wrong values are type errors", () => {
		const typo = diagnose(`import { defineConfig } from "@delacour/warden/config";
export default defineConfig({ projects: [{ name: "app", bundleId: {}, bundelId: {} }] });`);
		expect(typo.join("\n")).toContain("'bundelId' does not exist in type 'WardenProject'");
		const value = diagnose(`import { defineConfig } from "@delacour/warden/config";
export default defineConfig(() => ({ e2e: { m: { flowsDir: "f", runner: [], unmatched: "all" } } }));`);
		expect(value.join("\n")).toContain('"all"');
	});

	test("the .d.ts keeps the TSDoc; the .mjs runs", async () => {
		const dts = await Bun.file(join(pkg, CONFIG_ENTRY_DTS)).text();
		expect(dts).toContain("@default");
		expect(dts).toContain("export declare function defineConfig");
		const mod: { defineConfig: (c: object) => object } = await import(join(pkg, CONFIG_ENTRY_JS));
		const config = { batches: {} };
		expect(mod.defineConfig(config)).toBe(config);
	});
});
