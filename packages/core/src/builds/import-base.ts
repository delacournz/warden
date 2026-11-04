import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import type { Exec } from "../exec";

/** What a `.app` handed to `warden builds import --kind simulator-base` was found to be. */
export type SimulatorBaseFacts = {
	bundleId: string;
	/** `lipo -archs` of the main executable */
	archs: string[];
	/** it carries a `main.jsbundle` (built without `SKIP_BUNDLING`): stripped on import, the repack writes its own */
	embeddedBundle: boolean;
};

export type SimulatorBaseCheck = {
	/** the project's iOS bundle id: a base of another app is never a base of this one */
	bundleId: string;
	/** the slice this Mac's simulators run (`hostSimulatorArch`) */
	arch: "arm64" | "x86_64";
};

/** `process.arch` → the architecture simulators run on this Mac. */
export function hostSimulatorArch(arch: string = process.arch): "arm64" | "x86_64" {
	return arch === "arm64" ? "arm64" : "x86_64";
}

/** Files only a Debug or dev-client build has: a base is Release, the repack's JS would never load in one of these. */
function debugMarkers(executable: string): string[] {
	return [
		`${executable}.debug.dylib`,
		"__preview.dylib",
		"EXDevLauncher.bundle",
		"EXDevMenu.bundle",
		"Frameworks/EXDevLauncher.framework",
		"Frameworks/EXDevMenu.framework",
	];
}

function isExecutable(path: string): boolean {
	try {
		return (statSync(path).mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

async function plistValue(exec: Exec, app: string, key: string): Promise<string | undefined> {
	const run = await exec(["plutil", "-extract", key, "raw", "-o", "-", join(app, "Info.plist")]);
	const value = run.stdout.trim();
	return run.exitCode === 0 && value !== "" ? value : undefined;
}

/**
 * Is `app` usable as the `simulator-base` of this project? A simulator build (`DTPlatformName` `iphonesimulator`) with
 * a slice for this Mac's simulators, the project's bundle id, and no Debug / expo-dev-client payload. An embedded
 * `main.jsbundle` is allowed and reported: the import strips it and every repack writes its own.
 */
export async function checkSimulatorBase(
	exec: Exec,
	app: string,
	check: SimulatorBaseCheck
): AsyncResult<SimulatorBaseFacts> {
	const name = basename(app);
	const [bundleId, executable, platform] = await Promise.all([
		plistValue(exec, app, "CFBundleIdentifier"),
		plistValue(exec, app, "CFBundleExecutable"),
		plistValue(exec, app, "DTPlatformName"),
	]);
	if (bundleId === undefined || executable === undefined) {
		return err(`${name}: no CFBundleIdentifier / CFBundleExecutable in Info.plist (not an iOS app build)`);
	}
	if (platform !== "iphonesimulator") {
		return err(
			`${name} is built for ${platform ?? "an unknown platform"}, not the simulator: build with -sdk iphonesimulator`
		);
	}
	if (bundleId !== check.bundleId) {
		return err(
			`${name} is ${bundleId}, the project's iOS bundle id is ${check.bundleId}: import a build of this project (or pass --bundle-id)`
		);
	}
	const binary = join(app, executable);
	if (!isExecutable(binary)) {
		return err(
			`${name}/${executable} is not executable (an actions/upload-artifact zip drops the mode bits): tar the .app before uploading it, and untar it here`
		);
	}
	const lipo = await exec(["lipo", "-archs", binary]);
	const archs = lipo.exitCode === 0 ? lipo.stdout.trim().split(/\s+/).filter(Boolean) : [];
	if (!archs.includes(check.arch)) {
		return err(
			`${name} has no ${check.arch} slice (${archs.join(" ") || "lipo could not read it"}): build with ARCHS=${check.arch}`
		);
	}
	const debug = debugMarkers(executable).find((marker) => existsSync(join(app, marker)));
	if (debug !== undefined) {
		return err(
			`${name} is a Debug or dev-client build (${debug}): import a Release build (-configuration Release, no expo-dev-client)`
		);
	}
	return ok({ bundleId, archs, embeddedBundle: existsSync(join(app, "main.jsbundle")) });
}
