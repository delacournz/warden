import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DriverError } from "@delacour/warden-driver/driver.types";
import { driverErrors } from "@delacour/warden-driver/errors";
import type { Result } from "@delacour/warden-types/result";
import type { OpenIosDriverOptions } from "./ios-driver";

export const HELPER_NAME = "warden-simd";
/** the env names `locateHelper` is keyed by (same strings as `SIMD_ENV` / `.helperDir`; the caller reads the env) */
export const SIMD_ENV = "WARDEN_SIMD";
export const HELPER_DIR_ENV = "WARDEN_HELPER_DIR";

export type LocateHelperInput = {
	/** `WARDEN_SIMD` (a file) and `WARDEN_HELPER_DIR` (a directory holding `warden-simd`) are read from here */
	env: Readonly<Record<string, string | undefined>>;
	/** `process.execPath`: a compiled `warden` ships the helper next to itself */
	execPath: string;
	/** directory of this module (`packages/driver-ios/src`), anchors the source-checkout build output */
	importDir: string;
	/** `$WARDEN_HOME` (resolved), where `warden doctor` / installs stage `simd/<version>/warden-simd`; without it that lookup step is skipped */
	wardenHome?: string;
	/** warden version for the staged copy; without it that lookup step is skipped */
	version?: string;
	/** file existence, injected */
	exists: (path: string) => boolean;
	/** symlink resolution, injected; defaults to identity */
	realpath?: (path: string) => string;
	/** `darwin-arm64`: names the `@delacour/warden-<target>` package that may ship the helper; without it that step is skipped */
	platformTarget?: string;
	/** resolve `@delacour/warden-<target>/package.json` to a path from the SDK's install location (`undefined` = not installed), injected */
	resolvePackage?: (specifier: string) => string | undefined;
};

export type HelperLocation = {
	path: string;
	source: "WARDEN_SIMD" | "WARDEN_HELPER_DIR" | "execPath" | "source-build" | "warden-home" | "platform-package";
};

export const DOCTOR_HINT =
	"run `warden doctor` to check the iOS driver helper, or set WARDEN_SIMD=/path/to/warden-simd";

type Candidate = { path: string; source: HelperLocation["source"] };

/** The install locations searched when no env var names the helper, in order. */
function installCandidates(input: LocateHelperInput, realpath: (path: string) => string): Candidate[] {
	const candidates: Candidate[] = [
		{ path: join(dirname(realpath(input.execPath)), HELPER_NAME), source: "execPath" },
		{ path: resolve(input.importDir, "../native/dist", HELPER_NAME), source: "source-build" },
	];
	if (input.version && input.wardenHome) {
		candidates.push({ path: join(input.wardenHome, "simd", input.version, HELPER_NAME), source: "warden-home" });
	}
	if (input.platformTarget && input.resolvePackage) {
		const manifest = input.resolvePackage(`@delacour/warden-${input.platformTarget}/package.json`);
		if (manifest) candidates.push({ path: join(dirname(manifest), "bin", HELPER_NAME), source: "platform-package" });
	}
	return candidates;
}

/**
 * Find the `warden-simd` binary. Order: `WARDEN_SIMD` (file) → `WARDEN_HELPER_DIR/warden-simd` →
 * next to the real path of the running executable → `<packages/driver-ios>/native/dist/warden-simd` →
 * `$WARDEN_HOME/simd/<version>/warden-simd` → `bin/warden-simd` of the installed `@delacour/warden-<target>` npm
 * package (how `@delacour/warden-sdk` finds it: its optionalDependencies install it, `bin` points at the helper). An explicitly set env var that points at nothing is an
 * error, not a fall-through (a stale override should not silently pick another binary).
 */
export function locateHelper(input: LocateHelperInput): Result<HelperLocation, DriverError> {
	const resolveLink = input.realpath ?? ((path: string) => path);
	const realpath = (path: string): string => {
		try {
			return resolveLink(path);
		} catch {
			return path;
		}
	};
	const tried: string[] = [];
	const missing = (message: string): Result<HelperLocation, DriverError> => ({
		success: false,
		error: driverErrors.make("E_HELPER_MISSING", `${message}; ${DOCTOR_HINT}`, { detail: { tried } }),
	});

	const explicitFile = input.env[SIMD_ENV];
	if (explicitFile) {
		tried.push(explicitFile);
		return input.exists(explicitFile)
			? { success: true, data: { path: explicitFile, source: "WARDEN_SIMD" } }
			: missing(`WARDEN_SIMD=${explicitFile} does not exist`);
	}

	const helperDir = input.env[HELPER_DIR_ENV];
	if (helperDir) {
		const candidate = join(helperDir, HELPER_NAME);
		tried.push(candidate);
		return input.exists(candidate)
			? { success: true, data: { path: candidate, source: "WARDEN_HELPER_DIR" } }
			: missing(`WARDEN_HELPER_DIR=${helperDir} has no ${HELPER_NAME}`);
	}

	const candidates = installCandidates(input, realpath);
	for (const candidate of candidates) {
		tried.push(candidate.path);
		if (input.exists(candidate.path)) return { success: true, data: candidate };
	}
	return missing(`${HELPER_NAME} not found (tried ${tried.join(", ")})`);
}

function resolveInstalledPackage(from: string): (specifier: string) => string | undefined {
	return (specifier) => {
		try {
			return Bun.resolveSync(specifier, from);
		} catch {
			return undefined;
		}
	};
}

/**
 * The helper binary: the explicit `helperPath`, else `locateHelper` over the env / install locations. Lives here,
 * not in `ios-driver.ts`, so a caller that only needs the path (`warden ui` spawning or replacing the helper)
 * does not load the driver and its protocol schemas.
 */
export function resolveHelper(o: OpenIosDriverOptions): Result<string, DriverError> {
	if (o.helperPath !== undefined) return { success: true, data: o.helperPath };
	const importDir = o.importDir ?? import.meta.dir;
	const located = locateHelper({
		env: { [SIMD_ENV]: o.env?.simd, [HELPER_DIR_ENV]: o.env?.helperDir },
		execPath: o.execPath ?? process.execPath,
		importDir,
		platformTarget: o.platformTarget ?? `${process.platform}-${process.arch}`,
		resolvePackage: o.resolvePackage ?? resolveInstalledPackage(importDir),
		...(o.wardenHome ? { wardenHome: o.wardenHome } : {}),
		exists: o.exists ?? existsSync,
		realpath: o.realpath ?? realpathSync,
		...(o.version ? { version: o.version } : {}),
	});
	return located.success ? { success: true, data: located.data.path } : located;
}
