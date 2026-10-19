#!/usr/bin/env bun
/**
 * Publish every warden npm package at one version.
 *   bun run release 0.2.0
 *
 * Writes that version into the cli and e2e package.jsons, commits it on the current branch,
 * then builds and `npm publish`es the platform packages, `@delacour/warden`, and
 * `@delacour/warden-e2e` (platform packages first). A version already on npm is skipped.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";
import { RELEASE_TARGETS } from "../src/npm/platforms";
import { parseVersion } from "../src/update/version";

/** Source manifests whose `version` is the published lock-step version. Generated npm manifests copy the cli one. */
export const VERSION_FILES = ["apps/cli/package.json", "packages/e2e/package.json"] as const;

const VERSION_FIELD = /("version"[ \t]*:[ \t]*")[^"]*(")/;

/** `v1.2.3` and `1.2.3` → `1.2.3`; anything else → undefined. */
export function releaseVersion(input: string): string | undefined {
	const parsed = parseVersion(input);
	if (!parsed) return undefined;
	const pre = parsed.pre.length > 0 ? `-${parsed.pre.join(".")}` : "";
	return `${parsed.major}.${parsed.minor}.${parsed.patch}${pre}`;
}

/** Replace the top-level `"version"` and leave every later version string alone. */
export function withPackageVersion(source: string, version: string): string {
	if (!VERSION_FIELD.test(source)) throw new Error("package.json has no version field");
	return source.replace(VERSION_FIELD, `$1${version}$2`);
}

/** Write `version` into each `VERSION_FILES` entry. Returns the paths whose contents changed. */
export function applyVersion(root: string, version: string): string[] {
	const changed: string[] = [];
	for (const file of VERSION_FILES) {
		const path = join(root, file);
		const source = readFileSync(path, "utf8");
		const next = withPackageVersion(source, version);
		if (next === source) continue;
		writeFileSync(path, next);
		changed.push(file);
	}
	return changed;
}

/** Platform packages, then `@delacour/warden`, then `@delacour/warden-e2e` (exact peer on warden). */
export function publishPackageDirs(npmDir: string): string[] {
	return [
		...RELEASE_TARGETS.map((target) => join(npmDir, `warden-${target}`)),
		join(npmDir, "warden"),
		join(npmDir, "warden-e2e"),
	];
}

function takeVersion(argv: string[]): string {
	const { positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true });
	const [input, extra] = positionals;
	if (!input || extra !== undefined) throw new Error("usage: bun run release <version>");
	const version = releaseVersion(input);
	if (!version) throw new Error(`not a version: ${input}`);
	return version;
}

function isVersionFile(file: string): file is (typeof VERSION_FILES)[number] {
	return VERSION_FILES.some((versionFile) => versionFile === file);
}

function packageVersion(root: string, file: string): string | undefined {
	const raw: unknown = JSON.parse(readFileSync(join(root, file), "utf8"));
	if (typeof raw !== "object" || raw === null || !("version" in raw)) return undefined;
	return typeof raw.version === "string" ? raw.version : undefined;
}

/** A clean tree, or a retry whose only dirty files are the version manifests already at `version`. */
async function assertReleasable(root: string, version: string): Promise<void> {
	const status = (await $`git status --porcelain`.cwd(root).text()).trim();
	if (status === "") return;
	const dirty = status.split("\n").flatMap((line) => {
		const path = /^.. (.*)$/.exec(line)?.[1];
		return path ? [path] : [];
	});
	const extra = dirty.filter((file) => !isVersionFile(file));
	if (extra.length > 0) {
		throw new Error(`working tree is dirty (${extra.join(", ")}); commit or stash before releasing`);
	}
	for (const file of dirty) {
		if (packageVersion(root, file) !== version) {
			throw new Error(`${file} has uncommitted changes; commit or stash before releasing`);
		}
	}
}

async function commitVersion(root: string, version: string): Promise<void> {
	const pending = (await $`git status --porcelain -- ${[...VERSION_FILES]}`.cwd(root).text()).trim();
	if (pending === "") {
		console.log(`${version} already committed`);
		return;
	}
	const message = `🔧 chore(release): ${version}`;
	await $`git add ${[...VERSION_FILES]}`.cwd(root);
	await $`git commit -m ${message} -- ${[...VERSION_FILES]}`.cwd(root);
	console.log(`committed ${message}`);
}

/** `1` once the GitHub repo is public, so the staged manifests gain repository links. */
async function repoLinks(root: string): Promise<"0" | "1"> {
	const set = process.env.WARDEN_NPM_REPO_LINKS;
	if (set === "1" || set === "0") return set;
	const view = await $`gh repo view --json isPrivate --jq .isPrivate`.cwd(root).quiet().nothrow();
	return view.exitCode === 0 && view.stdout.toString().trim() === "false" ? "1" : "0";
}

async function buildPackages(root: string): Promise<void> {
	const e2e = join(root, "packages", "e2e");
	const cli = join(root, "apps", "cli");
	await $`bun run --cwd ${e2e} native:deps`.cwd(root);
	await $`bun run --cwd ${e2e} native:build`.cwd(root);
	await $`bun run --cwd ${cli} build:release`.cwd(root);
	process.env.WARDEN_NPM_REPO_LINKS = await repoLinks(root);
	await $`bun run --cwd ${cli} build:npm -- --require-helper`.cwd(root);
}

type Manifest = { name: string; version: string };

function readManifest(dir: string): Manifest {
	const raw: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	if (typeof raw !== "object" || raw === null || !("name" in raw) || !("version" in raw)) {
		throw new Error(`${dir}/package.json has no name and version`);
	}
	const { name, version } = raw;
	if (typeof name !== "string" || typeof version !== "string") {
		throw new Error(`${dir}/package.json has no name and version`);
	}
	return { name, version };
}

async function publishAll(root: string, version: string): Promise<void> {
	for (const dir of publishPackageDirs(join(root, "apps", "cli", "dist", "npm"))) {
		const manifest = readManifest(dir);
		if (manifest.version !== version) {
			throw new Error(`${manifest.name} is staged at ${manifest.version}, expected ${version}`);
		}
		const spec = `${manifest.name}@${manifest.version}`;
		const view = await $`npm view ${spec} version`.cwd(root).quiet().nothrow();
		if (view.exitCode === 0) {
			console.log(`${spec} already published, skipping`);
			continue;
		}
		console.log(`publishing ${spec}`);
		await $`npm publish ${dir} --access public --ignore-scripts`.cwd(root);
	}
}

async function main(): Promise<void> {
	const version = takeVersion(process.argv.slice(2));
	const root = resolve(import.meta.dir, "..", "..", "..");
	const who = await $`npm whoami`.cwd(root).quiet().nothrow();
	if (who.exitCode !== 0) throw new Error("npm whoami failed; run `npm login` before releasing");
	console.log(`publishing as ${who.stdout.toString().trim()}`);
	await assertReleasable(root, version);
	applyVersion(root, version);
	await commitVersion(root, version);
	await buildPackages(root);
	await publishAll(root, version);
	console.log(`published ${version}`);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
