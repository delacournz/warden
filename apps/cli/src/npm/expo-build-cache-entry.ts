import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { emitDeclarations } from "./config-entry";
import { EXPO_BUILD_CACHE_DTS, EXPO_BUILD_CACHE_JS } from "./manifests";

/** The provider bundled for Node (Expo loads it in its own process): plain CommonJS, no dependencies. */
const MAIN = fileURLToPath(new URL("./expo-build-cache-main.ts", import.meta.url));
/** The provider's types: self-contained, so they compile to the package's `.d.ts`. */
const TYPES = fileURLToPath(new URL("./expo-build-cache.types.ts", import.meta.url));

/** What the CommonJS module exports, beside the types: the provider itself and its three functions. */
const EXPORTS_DTS = `
declare const provider: ExpoBuildCacheProvider;
export default provider;
export declare const calculateFingerprintHash: ExpoBuildCacheProvider["calculateFingerprintHash"];
export declare const resolveBuildCache: ExpoBuildCacheProvider["resolveBuildCache"];
export declare const uploadBuildCache: ExpoBuildCacheProvider["uploadBuildCache"];
`;

/**
 * Write `@delacour/warden/expo-build-cache` into the staged main package `pkgDir`: `EXPO_BUILD_CACHE_JS` (CommonJS
 * for Node, run by `expo run:ios` through `buildCacheProvider: { plugin: "@delacour/warden/expo-build-cache" }`) and
 * `EXPO_BUILD_CACHE_DTS`.
 */
export async function buildExpoBuildCache(pkgDir: string): AsyncResult<void> {
	const built = await Bun.build({
		entrypoints: [MAIN],
		target: "node",
		format: "cjs",
		external: ["@delacour/warden/package.json"],
	});
	const [bundle] = built.outputs;
	if (!built.success || !bundle) return err(`expo build cache bundle failed:\n${built.logs.join("\n")}`);
	const types = await emitDeclarations(TYPES);
	if (!types.success) return types;
	for (const [path, text] of [
		[EXPO_BUILD_CACHE_JS, await bundle.text()],
		[EXPO_BUILD_CACHE_DTS, `${types.data}${EXPORTS_DTS}`],
	] as const) {
		const out = join(pkgDir, path);
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, text);
	}
	return ok(undefined);
}
