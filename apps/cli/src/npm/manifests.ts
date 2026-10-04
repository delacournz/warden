import { NPM_PACKAGE, platformPackageName, RELEASE_TARGETS, type ReleaseTarget } from "./platforms";

/**
 * Fields every published package shares, taken from `apps/cli/package.json`. `repository`
 * (`owner/name` on GitHub) adds repository / homepage / bugs links; leave it out while the repo is private.
 */
export type PackageMeta = { version: string; description: string; license: string; repository?: string };

type RepoLinks = { repository?: { type: "git"; url: string }; homepage?: string; bugs?: { url: string } };
type PublishConfig = { access: "public" };

export type PlatformManifest = RepoLinks & {
	name: string;
	version: string;
	description: string;
	license: string;
	os: string[];
	cpu: string[];
	files: string[];
	preferUnplugged: true;
	publishConfig: PublishConfig;
};

export type MainManifest = RepoLinks & {
	name: string;
	version: string;
	description: string;
	license: string;
	keywords: string[];
	bin: { warden: string };
	exports: Record<string, string | { types: string; default: string }>;
	files: string[];
	engines: { node: string };
	optionalDependencies: Record<string, string>;
	publishConfig: PublishConfig;
};

/** Path of the bundled shim inside the main package (also its `bin`). */
export const SHIM_PATH = "bin/warden.mjs";
/** `@delacour/warden/config` (`defineConfig` for `warden.config.ts`) inside the main package. */
export const CONFIG_ENTRY_JS = "config/index.mjs";
export const CONFIG_ENTRY_DTS = "config/index.d.ts";
/** Path of the compiled binary inside a platform package. */
export const BINARY_PATH = "bin/warden";
/** Copied from the repo root into every package. */
export const LICENSE_FILE = "LICENSE";

function repoLinks(repo: string | undefined): RepoLinks {
	if (!repo) return {};
	return {
		repository: { type: "git", url: `git+https://github.com/${repo}.git` },
		homepage: `https://github.com/${repo}#readme`,
		bugs: { url: `https://github.com/${repo}/issues` },
	};
}

/** `@delacour/warden-<os>-<cpu>`: just the binary, installable only on its os/cpu. */
export function platformManifest(target: ReleaseTarget, meta: PackageMeta): PlatformManifest {
	const [os = "", cpu = ""] = target.split("-");
	return {
		name: platformPackageName(target),
		version: meta.version,
		description: `The ${target} binary for ${NPM_PACKAGE}`,
		license: meta.license,
		...repoLinks(meta.repository),
		os: [os],
		cpu: [cpu],
		files: [BINARY_PATH, LICENSE_FILE],
		preferUnplugged: true,
		publishConfig: { access: "public" },
	};
}

/**
 * `@delacour/warden`: a JS shim bin, the `./config` entry (`defineConfig` + types) and every platform
 * package as an exact-version optional dependency. The package manager installs only the one matching this machine's os/cpu.
 */
export function mainManifest(meta: PackageMeta): MainManifest {
	return {
		name: NPM_PACKAGE,
		version: meta.version,
		description: meta.description,
		license: meta.license,
		...repoLinks(meta.repository),
		keywords: ["ios-simulator", "android-emulator", "leasing", "agents", "e2e", "cli"],
		bin: { warden: SHIM_PATH },
		exports: {
			"./config": { types: `./${CONFIG_ENTRY_DTS}`, default: `./${CONFIG_ENTRY_JS}` },
			"./package.json": "./package.json",
		},
		files: [SHIM_PATH, CONFIG_ENTRY_JS, CONFIG_ENTRY_DTS, "README.md", LICENSE_FILE],
		engines: { node: ">=18" },
		optionalDependencies: Object.fromEntries(
			RELEASE_TARGETS.map((target) => [platformPackageName(target), meta.version])
		),
		publishConfig: { access: "public" },
	};
}
