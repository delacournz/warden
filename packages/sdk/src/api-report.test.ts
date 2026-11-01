import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");

type Surface = { name: string; entry: string; declaration: string; report: string; mustContain: string };

const SURFACES: Surface[] = [
	{
		name: "public API surface",
		entry: resolve(PACKAGE_ROOT, "src/sdk.types.ts"),
		declaration: "sdk.types.d.ts",
		report: resolve(PACKAGE_ROOT, "api/warden-sdk.api.d.ts"),
		mustContain: "export interface WardenClient",
	},
	{
		name: "ai-sdk tool schemas",
		entry: resolve(PACKAGE_ROOT, "src/ai-sdk/tools.schema.ts"),
		declaration: "tools.schema.d.ts",
		report: resolve(PACKAGE_ROOT, "api/warden-sdk-ai-sdk-schema.api.d.ts"),
		mustContain: "toolInputSchemas",
	},
	{
		name: "ai-sdk tools adapter",
		entry: resolve(PACKAGE_ROOT, "src/ai-sdk/tools.ts"),
		declaration: "tools.d.ts",
		report: resolve(PACKAGE_ROOT, "api/warden-sdk-ai-sdk.api.d.ts"),
		mustContain: "export declare function createWardenTools",
	},
];

/** Emit the declaration of one entry with the TypeScript compiler API, in memory. */
function emitEntryDeclaration(entry: string, declaration: string): string {
	const configPath = resolve(PACKAGE_ROOT, "tsconfig.json");
	const config = ts.readConfigFile(configPath, ts.sys.readFile);
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, PACKAGE_ROOT);
	const program = ts.createProgram([entry], {
		...parsed.options,
		composite: false,
		rootDir: resolve(PACKAGE_ROOT, "../.."),
		noEmit: false,
		declaration: true,
		emitDeclarationOnly: true,
		removeComments: false,
	});
	let out = "";
	program.emit(program.getSourceFile(entry), (fileName, text) => {
		if (fileName.endsWith(declaration)) out = text;
	});
	return out;
}

/** A full tsc program per surface: seconds, more under a parallel `bun run test`. */
const EMIT_TIMEOUT_MS = 60_000;

for (const surface of SURFACES) {
	test(
		`${surface.name} matches ${surface.report.slice(PACKAGE_ROOT.length + 1)}`,
		() => {
			const actual = emitEntryDeclaration(surface.entry, surface.declaration);
			expect(actual).toContain(surface.mustContain);
			if (process.env.UPDATE_API_REPORT === "1") {
				mkdirSync(dirname(surface.report), { recursive: true });
				writeFileSync(surface.report, actual);
				return;
			}
			expect(existsSync(surface.report)).toBe(true);
			const committed = readFileSync(surface.report, "utf8");
			expect(actual).toBe(committed);
		},
		EMIT_TIMEOUT_MS
	);
}
