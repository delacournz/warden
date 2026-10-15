import { dirname, join, resolve } from "node:path";
import type { Result } from "@delacour/warden-types/result";
import type { DriverError } from "../driver.types";
import { driverError } from "../errors";

export const HELPER_NAME = "warden-simd";

export type LocateHelperInput = {
	/** `WARDEN_SIMD` (a file) and `WARDEN_HELPER_DIR` (a directory holding `warden-simd`) are read from here */
	env: Readonly<Record<string, string | undefined>>;
	/** `process.execPath`: a compiled `warden` ships the helper next to itself */
	execPath: string;
	/** directory of this module (`packages/e2e/src/driver/ios`), anchors the source-checkout build output */
	importDir: string;
	/** `$WARDEN_HOME` (resolved), where `warden doctor` / installs stage `simd/<version>/warden-simd` */
	wardenHome: string;
	/** warden version for the staged copy; without it that lookup step is skipped */
	version?: string;
	/** file existence, injected */
	exists: (path: string) => boolean;
	/** symlink resolution, injected; defaults to identity */
	realpath?: (path: string) => string;
};

export type HelperLocation = {
	path: string;
	source: "WARDEN_SIMD" | "WARDEN_HELPER_DIR" | "execPath" | "source-build" | "warden-home";
};

const DOCTOR_HINT = "run `warden doctor` to check the iOS driver helper, or set WARDEN_SIMD=/path/to/warden-simd";

/**
 * Find the `warden-simd` binary. Order: `WARDEN_SIMD` (file) → `WARDEN_HELPER_DIR/warden-simd` →
 * next to the real path of the running executable → `<packages/e2e>/native/dist/warden-simd` →
 * `$WARDEN_HOME/simd/<version>/warden-simd`. An explicitly set env var that points at nothing is an
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
		error: driverError("E_HELPER_MISSING", `${message}; ${DOCTOR_HINT}`, { detail: { tried } }),
	});

	const explicitFile = input.env.WARDEN_SIMD;
	if (explicitFile) {
		tried.push(explicitFile);
		return input.exists(explicitFile)
			? { success: true, data: { path: explicitFile, source: "WARDEN_SIMD" } }
			: missing(`WARDEN_SIMD=${explicitFile} does not exist`);
	}

	const helperDir = input.env.WARDEN_HELPER_DIR;
	if (helperDir) {
		const candidate = join(helperDir, HELPER_NAME);
		tried.push(candidate);
		return input.exists(candidate)
			? { success: true, data: { path: candidate, source: "WARDEN_HELPER_DIR" } }
			: missing(`WARDEN_HELPER_DIR=${helperDir} has no ${HELPER_NAME}`);
	}

	const candidates: { path: string; source: HelperLocation["source"] }[] = [
		{ path: join(dirname(realpath(input.execPath)), HELPER_NAME), source: "execPath" },
		{ path: resolve(input.importDir, "../../../native/dist", HELPER_NAME), source: "source-build" },
	];
	if (input.version) {
		candidates.push({ path: join(input.wardenHome, "simd", input.version, HELPER_NAME), source: "warden-home" });
	}
	for (const candidate of candidates) {
		tried.push(candidate.path);
		if (input.exists(candidate.path)) return { success: true, data: candidate };
	}
	return missing(`${HELPER_NAME} not found (tried ${tried.join(", ")})`);
}
