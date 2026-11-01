#!/usr/bin/env bun
/**
 * Stage the npm packages from `build:release` output (run that first):
 *   dist/npm/warden-<target>/  → @delacour/warden-<target>: package.json + bin/warden (the compiled binary)
 *   dist/npm/warden/           → @delacour/warden: package.json + bin/warden.mjs (node shim) + README.md
 *                                + config/index.{mjs,d.ts} (`@delacour/warden/config`: defineConfig + types)
 * darwin-arm64 also gets the simulator helper (`bin/{warden-simd, Resources/, *.framework, manifest.json}`) copied from
 * `packages/driver-ios/native/dist` (override: `WARDEN_E2E_NATIVE_DIST`) when it is built; `--require-helper` (release) makes
 * a missing helper an error.
 *   dist/npm/warden-e2e/       → @delacour/warden-e2e: package.json + index.mjs/preload.mjs (+ chunk) + index.d.ts/preload.d.ts
 *                                + types/ (the spec API for `warden e2e`, bundled from packages/e2e; lock-step with warden)
 *   dist/npm/warden-sdk/       → @delacour/warden-sdk: package.json + index.mjs, ai-sdk/, plugins/, contracts/ (+ chunks) + .d.ts + types/
 *                                (`createWardenClient`, bundled from packages/sdk; `zod` dependency, `ai` optional peer,
 *                                exact optionalDependencies on the platform packages; lock-step with warden)
 * `--sdk-only [--out <dir>]` stages just the SDK (no `build:release` needed), for packing and tests.
 * Every package also gets the repo-root LICENSE. Repository / homepage / bugs links are added only with
 * `--repo-links` or `WARDEN_NPM_REPO_LINKS=1` (the release workflow sets it once the repo is public).
 * Publishing is the release workflow's job: platform packages first, then @delacour/warden, then
 * @delacour/warden-e2e and @delacour/warden-sdk.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import cliPackage from "../package.json" with { type: "json" };
import { npmConfigEntry } from "../src/npm/config-entry";
import { e2eStage } from "../src/npm/e2e-stage";
import { HELPER_TARGET, type StagedHelper } from "../src/npm/helper";
import { helperStage } from "../src/npm/helper-stage";
import { BIN_DIR, BINARY_PATH, LICENSE_FILE, npmManifests, type PackageMeta, SHIM_PATH } from "../src/npm/manifests";
import { RELEASE_TARGETS } from "../src/npm/platforms";
import { sdkStage } from "../src/npm/sdk-stage";
import { DEFAULT_RELEASE_REPO } from "../src/update/release";

const cliRoot = resolve(import.meta.dir, "..");
const dist = join(cliRoot, "dist");
const repoRoot = resolve(cliRoot, "..", "..");
const { values } = parseArgs({
	options: {
		"repo-links": { type: "boolean", default: false },
		"require-helper": { type: "boolean", default: false },
		"sdk-only": { type: "boolean", default: false },
		out: { type: "string" },
	},
	strict: true,
});
const out = values.out === undefined ? join(dist, "npm") : resolve(values.out);
const helperDist = process.env.WARDEN_E2E_NATIVE_DIST || join(repoRoot, "packages", "driver-ios", "native", "dist");
const repoLinks = values["repo-links"] || process.env.WARDEN_NPM_REPO_LINKS === "1";
const meta: PackageMeta = {
	version: cliPackage.version,
	description: cliPackage.description,
	license: cliPackage.license,
	...(repoLinks ? { repository: DEFAULT_RELEASE_REPO } : {}),
};

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

if (values["sdk-only"]) {
	const only = await sdkStage.stageSdk({ repoRoot, outDir: join(out, "warden-sdk"), meta });
	if (!only.success) throw new Error(only.error);
	console.log(`staged ${join(out, "warden-sdk")}`);
	process.exit(0);
}

const missing = RELEASE_TARGETS.filter((target) => !existsSync(join(dist, `warden-${target}`)));
if (missing.length > 0) {
	throw new Error(`missing ${missing.map((t) => `dist/warden-${t}`).join(", ")} — run \`bun run build:release\` first`);
}
rmSync(out, { recursive: true, force: true });

for (const target of RELEASE_TARGETS) {
	const dir = join(out, `warden-${target}`);
	let helper: StagedHelper | undefined;
	if (target === HELPER_TARGET) {
		const staged = helperStage.stageHelper({
			distDir: helperDist,
			binDir: join(dir, BIN_DIR),
			required: values["require-helper"],
		});
		if (!staged.success) throw new Error(staged.error);
		helper = staged.data;
	}
	writeJson(join(dir, "package.json"), npmManifests.platformManifest(target, meta, helper));
	const binary = join(dir, BINARY_PATH);
	mkdirSync(dirname(binary), { recursive: true });
	copyFileSync(join(dist, `warden-${target}`), binary);
	chmodSync(binary, 0o755);
	copyFileSync(join(repoRoot, LICENSE_FILE), join(dir, LICENSE_FILE));
	console.log(`staged dist/npm/warden-${target}${helper ? ` (+ warden-simd ${helper.version})` : ""}`);
}

const main = join(out, "warden");
writeJson(join(main, "package.json"), npmManifests.mainManifest(meta));
const shim = await Bun.build({
	entrypoints: [join(cliRoot, "src", "npm", "shim-main.ts")],
	target: "node",
	format: "esm",
});
const [bundle] = shim.outputs;
if (!shim.success || !bundle) throw new Error(`shim bundle failed:\n${shim.logs.join("\n")}`);
const code = await bundle.text();
const shimPath = join(main, SHIM_PATH);
mkdirSync(dirname(shimPath), { recursive: true });
writeFileSync(shimPath, code.startsWith("#!") ? code : `#!/usr/bin/env node\n${code}`);
chmodSync(shimPath, 0o755);
const configEntry = await npmConfigEntry.buildConfigEntry(main);
if (!configEntry.success) throw new Error(configEntry.error);
copyFileSync(join(repoRoot, "README.md"), join(main, "README.md"));
copyFileSync(join(repoRoot, LICENSE_FILE), join(main, LICENSE_FILE));
console.log("staged dist/npm/warden");

const e2e = await e2eStage.stageE2e({ repoRoot, outDir: join(out, "warden-e2e"), meta });
if (!e2e.success) throw new Error(e2e.error);
console.log("staged dist/npm/warden-e2e");

const sdk = await sdkStage.stageSdk({ repoRoot, outDir: join(out, "warden-sdk"), meta });
if (!sdk.success) throw new Error(sdk.error);
console.log("staged dist/npm/warden-sdk");

console.log(
	`npm ${meta.version}: ${RELEASE_TARGETS.length} platform packages + @delacour/warden + @delacour/warden-e2e + @delacour/warden-sdk${repoLinks ? "" : " (no repo links)"}`
);
