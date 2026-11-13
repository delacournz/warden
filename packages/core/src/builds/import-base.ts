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
	/**
	 * the app's entitlements (its code signature, or the `__TEXT,__entitlements` section an ad-hoc simulator build links
	 * in) carry an `application-identifier`; false for an unsigned app or one built without it
	 * (`CODE_SIGNING_ALLOWED=NO`), whose Keychain calls fail with errSecMissingEntitlement (-34018) on a simulator;
	 * undefined when neither `codesign` nor `otool` could say
	 */
	applicationIdentifier?: boolean;
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
 * The text of a section as `otool -X -s <seg> <sect>` prints it: each line is an address, then the bytes, one per
 * token (x86_64) or as little-endian 32-bit words (arm64). undefined when otool could not read the binary.
 */
async function sectionText(exec: Exec, binary: string, segment: string, section: string): Promise<string | undefined> {
	const run = await exec(["otool", "-X", "-s", segment, section, binary]);
	if (run.exitCode !== 0) return undefined;
	const bytes: number[] = [];
	for (const line of run.stdout.split("\n")) {
		for (const token of line.trim().split(/\s+/).slice(1)) {
			if (!/^(?:[0-9a-f]{2}|[0-9a-f]{8})$/i.test(token)) continue;
			const pairs = token.match(/../g) ?? [];
			if (token.length === 8) pairs.reverse();
			for (const pair of pairs) bytes.push(Number.parseInt(pair, 16));
		}
	}
	return Buffer.from(bytes).toString("utf8");
}

/**
 * Does the build embed an `application-identifier` entitlement? A device build carries it in its code signature. An
 * ad-hoc simulator build (`CODE_SIGN_IDENTITY=-`) signs with no entitlements and links them into the executable's
 * `__TEXT,__entitlements` section, which is what the simulator reads. undefined when neither codesign nor otool can say.
 */
async function hasApplicationIdentifier(exec: Exec, app: string, binary: string): Promise<boolean | undefined> {
	const signature = await exec(["codesign", "-d", "--entitlements", ":-", app]);
	if (signature.exitCode === 0 && signature.stdout.includes("application-identifier")) return true;
	const section = await sectionText(exec, binary, "__TEXT", "__entitlements");
	if (section?.includes("<key>application-identifier</key>")) return true;
	if (section !== undefined || signature.exitCode === 0) return false;
	return /not signed at all/i.test(signature.stderr) ? false : undefined;
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
	const applicationIdentifier = await hasApplicationIdentifier(exec, app, binary);
	return ok({
		bundleId,
		archs,
		embeddedBundle: existsSync(join(app, "main.jsbundle")),
		...(applicationIdentifier !== undefined ? { applicationIdentifier } : {}),
	});
}
