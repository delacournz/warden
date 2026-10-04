import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import ts from "typescript";
import { CONFIG_ENTRY_DTS, CONFIG_ENTRY_JS } from "./manifests";

/** `defineConfig` + the documented config types; self-contained, so it compiles to one `.d.ts` + one `.mjs`. */
const SOURCE = fileURLToPath(import.meta.resolve("@delacour/warden-core/builds/define-config"));

/** The declarations of `SOURCE`, TSDoc kept. */
function emitDeclarations(): AsyncResult<string> {
	let dts: string | undefined;
	const program = ts.createProgram([SOURCE], {
		declaration: true,
		emitDeclarationOnly: true,
		strict: true,
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		types: [],
	});
	const result = program.emit(undefined, (name, text) => {
		if (name.endsWith(".d.ts")) dts = text;
	});
	const problems = [...ts.getPreEmitDiagnostics(program), ...result.diagnostics];
	if (problems.length > 0) {
		return Promise.resolve(err(problems.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n")));
	}
	return Promise.resolve(dts === undefined ? err(`no declarations emitted for ${SOURCE}`) : ok(dts));
}

/**
 * Write `@delacour/warden/config` into the staged main package `pkgDir`: `CONFIG_ENTRY_JS` (node ESM) and
 * `CONFIG_ENTRY_DTS`, so a `warden.config.ts` gets autocompletion + docs from `defineConfig`.
 */
export async function buildConfigEntry(pkgDir: string): AsyncResult<void> {
	const built = await Bun.build({ entrypoints: [SOURCE], target: "node", format: "esm" });
	const [bundle] = built.outputs;
	if (!built.success || !bundle) return err(`config entry bundle failed:\n${built.logs.join("\n")}`);
	const dts = await emitDeclarations();
	if (!dts.success) return dts;
	for (const [path, text] of [
		[CONFIG_ENTRY_JS, await bundle.text()],
		[CONFIG_ENTRY_DTS, dts.data],
	] as const) {
		const out = join(pkgDir, path);
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, text);
	}
	return ok(undefined);
}
