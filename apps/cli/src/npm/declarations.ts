import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";
import ts from "typescript";

/**
 * Workspace package → its directory under `packages/`. Their declarations are emitted next to
 * `@delacour/warden-e2e`'s own and the bare specifiers rewritten to relative paths, because the published
 * package depends on none of them (the JS is bundled, the types are shipped).
 */
const WORKSPACE_PACKAGES: Readonly<Record<string, string>> = {
	"@delacour/warden-builds": "builds",
	"@delacour/warden-config": "config",
	"@delacour/warden-core": "core",
	"@delacour/warden-leasing": "leasing",
	"@delacour/warden-perf": "perf",
	"@delacour/warden-providers": "providers",
	"@delacour/warden-runtime": "runtime",
	"@delacour/warden-store": "store",
	"@delacour/warden-types": "types",
	"@delacour/warden-device": "device",
	"@delacour/warden-devtools": "devtools",
	"@delacour/warden-driver": "driver",
	"@delacour/warden-driver-android": "driver-android",
	"@delacour/warden-driver-ios": "driver-ios",
	"@delacour/warden-e2e": "e2e",
	"@delacour/warden-screen": "screen",
};

const SPECIFIER = new RegExp(
	`(["'])(${Object.keys(WORKSPACE_PACKAGES)
		.sort((a, b) => b.length - a.length)
		.map((name) => name.replace(/[/-]/g, "\\$&"))
		.join("|")})\\/([^"']+)\\1`,
	"g"
);

/**
 * `from "@delacour/warden-types/result"` → `from "../../types/src/result"` for a declaration file at `file`
 * under `typesDir`, where each workspace package's `src/` was emitted to `typesDir/<dir>/src`.
 * Their exports maps point `./<name>` at `./src/<name>.ts`, hence the fixed `src`.
 */
export function rewriteWorkspaceSpecifiers(text: string, file: string, typesDir: string): string {
	return text.replace(SPECIFIER, (match: string, quote: string, pkg: string, rest: string) => {
		const dir = WORKSPACE_PACKAGES[pkg];
		if (dir === undefined) return match;
		const target = relative(dirname(file), join(typesDir, dir, "src", rest));
		return `${quote}${target.startsWith(".") ? target : `./${target}`}${quote}`;
	});
}

const RELATIVE_SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']*)\2/g;

/**
 * `from "./foo"` → `from "./foo.js"` (or `./foo/index.js` for a directory) for a declaration file at `file`, so the
 * package resolves under `module: node16`/`nodenext` (relative ESM imports need an extension there; `.js` maps to the
 * sibling `.d.ts`). `exists` is injected. Specifiers that already end in an extension, and ones that resolve to nothing, stay.
 */
export function addEsmExtensions(text: string, file: string, exists: (path: string) => boolean): string {
	return text.replace(RELATIVE_SPECIFIER, (match: string, lead: string, quote: string, spec: string) => {
		if (/\.(?:m?js|cjs|json)$/.test(spec)) return match;
		const target = resolve(dirname(file), spec);
		if (exists(`${target}.d.ts`)) return `${lead}${quote}${spec}.js${quote}`;
		if (exists(join(target, "index.d.ts"))) return `${lead}${quote}${spec.replace(/\/$/, "")}/index.js${quote}`;
		return match;
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
	/** add `.js` to relative specifiers so the declarations resolve under `node16`/`nodenext` (see `addEsmExtensions`) */
	esmExtensions?: boolean;
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
	if (input.esmExtensions) {
		for (const file of written) writeFileSync(file, addEsmExtensions(readFileSync(file, "utf8"), file, existsSync));
	}
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
