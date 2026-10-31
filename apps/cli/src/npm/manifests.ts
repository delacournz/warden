import { HELPER_BINARY, HELPER_TARGET, type HelperInfo, helperFiles, type StagedHelper } from "./helper";
import { E2E_PACKAGE, NPM_PACKAGE, platformPackageName, RELEASE_TARGETS, type ReleaseTarget } from "./platforms";

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
	/** darwin-arm64 with the simulator helper: npm chmods bin targets on install, so `warden-simd` stays executable */
	bin?: Record<string, string>;
	/** read by `warden doctor` */
	warden?: { helper: HelperInfo };
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

export type E2eManifest = RepoLinks & {
	name: string;
	version: string;
	description: string;
	license: string;
	type: "module";
	keywords: string[];
	exports: Record<string, string | { types: string; default: string }>;
	files: string[];
	/** the exact warden this was published with: `warden e2e` starts the specs, the preload handshakes with it */
	peerDependencies: Record<string, string>;
	/** third-party runtime imports the bundle leaves external (`bun:test` is the runtime's own) */
	dependencies: Record<string, string>;
	engines: { bun: string };
	publishConfig: PublishConfig;
};

/** Where the bundled spec API lands in `@delacour/warden-e2e`, with its declarations. */
export const E2E_ENTRIES = {
	".": { js: "index.mjs", types: "index.d.ts" },
	"./preload": { js: "preload.mjs", types: "preload.d.ts" },
} as const;
/** Declaration files the entry `.d.ts` re-export (see `declarations.ts`). */
export const E2E_TYPES_DIR = "types";

/** Path of the bundled shim inside the main package (also its `bin`). */
export const SHIM_PATH = "bin/warden.mjs";
/** `@delacour/warden/config` (`defineConfig` for `warden.config.ts`) inside the main package. */
export const CONFIG_ENTRY_JS = "config/index.mjs";
export const CONFIG_ENTRY_DTS = "config/index.d.ts";
/** Path of the compiled binary inside a platform package. */
export const BIN_DIR = "bin";
export const BINARY_PATH = `${BIN_DIR}/warden`;
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

/**
 * `@delacour/warden-<os>-<cpu>`: the binary, installable only on its os/cpu. darwin-arm64 with a staged
 * `helper` also ships `warden-simd` + its resources next to the binary (other targets ignore `helper`).
 */
export function platformManifest(target: ReleaseTarget, meta: PackageMeta, helper?: StagedHelper): PlatformManifest {
	const [os = "", cpu = ""] = target.split("-");
	const shipped = target === HELPER_TARGET ? helper : undefined;
	return {
		name: platformPackageName(target),
		version: meta.version,
		description: `The ${target} binary for ${NPM_PACKAGE}`,
		license: meta.license,
		...repoLinks(meta.repository),
		os: [os],
		cpu: [cpu],
		files: [BINARY_PATH, ...(shipped ? helperFiles(BIN_DIR, shipped.frameworks, shipped.inject) : []), LICENSE_FILE],
		...(shipped
			? {
					bin: { [HELPER_BINARY]: `${BIN_DIR}/${HELPER_BINARY}` },
					warden: { helper: { version: shipped.version, idb: shipped.idb, xcode: shipped.xcode } },
				}
			: {}),
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

/**
 * `@delacour/warden-e2e`: the spec API (`import { test, expect } from "@delacour/warden-e2e"`) and the
 * `bun test --preload @delacour/warden-e2e/preload` entry. Public surface is `.` and `./preload` only: the
 * workspace-private `driver/*`, `env`, `runner/results` etc. are bundled in, and `apps/cli` (compiled separately)
 * imports them from the workspace. `zod` is the one third-party runtime import and stays a dependency;
 * `@delacour/warden` is a peer at the exact same version (lock-step).
 */
export function e2eManifest(meta: PackageMeta, dependencies: Record<string, string>): E2eManifest {
	return {
		name: E2E_PACKAGE,
		version: meta.version,
		description: "TypeScript spec API for `warden e2e`: test, expect, screen, device, app",
		license: meta.license,
		...repoLinks(meta.repository),
		type: "module",
		keywords: ["e2e", "ios-simulator", "android-emulator", "bun", "testing"],
		exports: {
			...Object.fromEntries(
				Object.entries(E2E_ENTRIES).map(([key, entry]) => [
					key,
					{ types: `./${entry.types}`, default: `./${entry.js}` },
				])
			),
			"./package.json": "./package.json",
		},
		files: ["*.mjs", "*.d.ts", E2E_TYPES_DIR, LICENSE_FILE],
		peerDependencies: { [NPM_PACKAGE]: meta.version },
		dependencies,
		engines: { bun: ">=1.3" },
		publishConfig: { access: "public" },
	};
}
