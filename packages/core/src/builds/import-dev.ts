import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import type { Exec } from "../exec";
import { isExecutable, plistValue, type SimulatorBaseCheck } from "./import-base";

/** What a `.app` handed to `warden builds import --kind dev` was found to be. */
export type DevBuildFacts = { bundleId: string; archs: string[] };

/**
 * Is `app` usable as this project's iOS `dev` build? A simulator build (`DTPlatformName` `iphonesimulator`) of the
 * project's bundle id with a slice for this Mac's simulators and no embedded `main.jsbundle` (a Debug build loads its JS
 * from Metro; a Release build would never connect to it).
 */
export async function checkDevBuild(exec: Exec, app: string, check: SimulatorBaseCheck): AsyncResult<DevBuildFacts> {
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
	if (!isExecutable(binary)) return err(`${name}/${executable} is not executable`);
	const lipo = await exec(["lipo", "-archs", binary]);
	const archs = lipo.exitCode === 0 ? lipo.stdout.trim().split(/\s+/).filter(Boolean) : [];
	if (!archs.includes(check.arch)) {
		return err(
			`${name} has no ${check.arch} slice (${archs.join(" ") || "lipo could not read it"}): build with ARCHS=${check.arch}`
		);
	}
	if (existsSync(join(app, "main.jsbundle"))) {
		return err(
			`${name} embeds main.jsbundle: it is a Release build, import a Debug one (expo run:ios, no --configuration Release)`
		);
	}
	return ok({ bundleId, archs });
}
