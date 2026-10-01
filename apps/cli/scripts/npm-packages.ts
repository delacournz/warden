#!/usr/bin/env bun
/**
 * Stage the npm packages from `build:release` output (run that first):
 *   dist/npm/warden-<target>/  → @delacour/warden-<target>: package.json + bin/warden (the compiled binary)
 *   dist/npm/warden/           → @delacour/warden: package.json + bin/warden.mjs (node shim) + README.md
 * Every package also gets the repo-root LICENSE. Repository / homepage / bugs links are added only with
 * `--repo-links` or `WARDEN_NPM_REPO_LINKS=1` (the release workflow sets it once the repo is public).
 * Publishing is the release workflow's job: platform packages first, then @delacour/warden.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import cliPackage from "../package.json" with { type: "json" };
import {
	BINARY_PATH,
	LICENSE_FILE,
	mainManifest,
	type PackageMeta,
	platformManifest,
	SHIM_PATH,
} from "../src/npm/manifests";
import { RELEASE_TARGETS } from "../src/npm/platforms";
import { DEFAULT_RELEASE_REPO } from "../src/update/release";

const cliRoot = resolve(import.meta.dir, "..");
const dist = join(cliRoot, "dist");
const out = join(dist, "npm");
const repoRoot = resolve(cliRoot, "..", "..");
const { values } = parseArgs({ options: { "repo-links": { type: "boolean", default: false } }, strict: true });
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

const missing = RELEASE_TARGETS.filter((target) => !existsSync(join(dist, `warden-${target}`)));
if (missing.length > 0) {
	throw new Error(`missing ${missing.map((t) => `dist/warden-${t}`).join(", ")} — run \`bun run build:release\` first`);
}
rmSync(out, { recursive: true, force: true });

for (const target of RELEASE_TARGETS) {
	const dir = join(out, `warden-${target}`);
	writeJson(join(dir, "package.json"), platformManifest(target, meta));
	const binary = join(dir, BINARY_PATH);
	mkdirSync(dirname(binary), { recursive: true });
	copyFileSync(join(dist, `warden-${target}`), binary);
	chmodSync(binary, 0o755);
	copyFileSync(join(repoRoot, LICENSE_FILE), join(dir, LICENSE_FILE));
	console.log(`staged dist/npm/warden-${target}`);
}

const main = join(out, "warden");
writeJson(join(main, "package.json"), mainManifest(meta));
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
copyFileSync(join(repoRoot, "README.md"), join(main, "README.md"));
copyFileSync(join(repoRoot, LICENSE_FILE), join(main, LICENSE_FILE));
console.log("staged dist/npm/warden");
console.log(
	`npm ${meta.version}: ${RELEASE_TARGETS.length} platform packages + @delacour/warden${repoLinks ? "" : " (no repo links)"}`
);
