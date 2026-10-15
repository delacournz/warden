import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";
import ts from "typescript";

/**
 * Workspace package → its directory under `packages/`. Their declarations are emitted next to
 * `@delacour/warden-e2e`'s own and the bare specifiers rewritten to relative paths, because the published
 * package depends on none of them (the JS is bundled, the types are shipped).
 */
const WORKSPACE_PACKAGES: Readonly<Record<string, string>> = {
	"@delacour/warden-core": "core",
	"@delacour/warden-types": "types",
	"@delacour/warden-e2e": "e2e",
};

const SPECIFIER = /(["'])(@delacour\/warden-(?:core|types|e2e))\/([^"']+)\1/g;

/**
 * `from "@delacour/warden-types/result"` → `from "../../types/src/result"` for a declaration file at `file`
 * under `typesDir`, where each workspace package's `src/` was emitted to `typesDir/<dir>/src`.
 * Their exports map is `./* → ./src/*.ts`, hence the fixed `src`.
 */
export function rewriteWorkspaceSpecifiers(text: string, file: string, typesDir: string): string {
	return text.replace(SPECIFIER, (match: string, quote: string, pkg: string, rest: string) => {
		const dir = WORKSPACE_PACKAGES[pkg];
		if (dir === undefined) return match;
		const target = relative(dirname(file), join(typesDir, dir, "src", rest));
		return `${quote}${target.startsWith(".") ? target : `./${target}`}${quote}`;
	});
}

/** An entry `.d.ts` that re-exports a module's emitted declarations: `export * from "./types/e2e/src/index"`. */
export function entryDeclaration(typesDirName: string, sourceRelative: string): string {
	return `export * from "./${typesDirName}/${sourceRelative.replace(/\.ts$/, "")}";\n`;
}

/**
 * `@delacour/warden-<x>/*` → `packages/<x>/src/*`. Without it the compiler finds these packages through
 * `node_modules` (workspace symlinks), counts them as external libraries and emits nothing for them, so the
 * published declarations would import files that are not there.
 */
function workspacePaths(packagesDir: string): Record<string, string[]> {
	return Object.fromEntries(
		Object.entries(WORKSPACE_PACKAGES).map(([name, dir]) => [`${name}/*`, [join(packagesDir, dir, "src", "*")]])
	);
}

export type EmitDeclarationsInput = {
	/** `packages/e2e/tsconfig.json`: the compiler options (module resolution, `bun` types) to emit with */
	tsconfigPath: string;
	/** entry sources (`packages/e2e/src/index.ts`, `preload.ts`); only what they reach is emitted */
	entries: readonly string[];
	/** the `packages/` directory: declarations land at `outDir/<package dir>/src/**.d.ts` */
	packagesDir: string;
	outDir: string;
};

/**
 * Declaration files for `entries` and everything they import (across workspace packages), written under `outDir`
 * with workspace specifiers made relative. Uses the TypeScript compiler API (`typescript` is already a dev
 * dependency): no bundler for `.d.ts`, no new package. Returns the written paths.
 */
export function emitDeclarations(input: EmitDeclarationsInput): Result<string[]> {
	const config = ts.readConfigFile(input.tsconfigPath, ts.sys.readFile);
	if (config.error) return err(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(input.tsconfigPath));
	const options: ts.CompilerOptions = {
		...parsed.options,
		declaration: true,
		emitDeclarationOnly: true,
		noEmit: false,
		composite: false,
		incremental: false,
		tsBuildInfoFile: undefined,
		skipLibCheck: true,
		outDir: input.outDir,
		rootDir: input.packagesDir,
		paths: workspacePaths(input.packagesDir),
	};
	const program = ts.createProgram([...input.entries], options);
	const written: string[] = [];
	const result = program.emit(undefined, (fileName, text) => {
		if (!fileName.endsWith(".d.ts")) return;
		mkdirSync(dirname(fileName), { recursive: true });
		writeFileSync(fileName, rewriteWorkspaceSpecifiers(text, fileName, input.outDir));
		written.push(fileName);
	});
	const errors = result.diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
	if (errors.length > 0) {
		return err(
			ts.formatDiagnostics(errors, {
				getCanonicalFileName: (f) => f,
				getCurrentDirectory: () => process.cwd(),
				getNewLine: () => "\n",
			})
		);
	}
	return ok(written);
}
