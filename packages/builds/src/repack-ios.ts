import { copyFileSync, cpSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Exec } from "@delacour/warden-runtime/exec";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
import type { ApplyRepack } from "./repack.types";

const BUNDLE = "main.jsbundle";
const EXPO_PLIST = "Expo.plist";

function failure(what: string, run: { stdout: string; stderr: string }): string {
	return `${what}: ${(run.stderr || run.stdout).trim().slice(-1000)}`;
}

/** `CFBundleIdentifier` of an `.app`, via `plutil`. */
async function bundleIdentifier(exec: Exec, app: string): AsyncResult<string> {
	const run = await exec(["plutil", "-extract", "CFBundleIdentifier", "raw", "-o", "-", join(app, "Info.plist")]);
	const id = run.stdout.trim();
	return run.exitCode === 0 && id !== ""
		? resultFactory.ok(id)
		: resultFactory.err(failure(`reading CFBundleIdentifier of ${basename(app)}`, run));
}

/** Copy the base with APFS clonefiles (`cp -c`, near-free); a plain copy where the volume cannot clone. */
async function cloneApp(exec: Exec, base: string, target: string): AsyncResult<void> {
	const clone = await exec(["cp", "-c", "-R", base, target]);
	if (clone.exitCode === 0) return resultFactory.ok(undefined);
	rmSync(target, { recursive: true, force: true });
	try {
		cpSync(base, target, { recursive: true, verbatimSymlinks: true });
		return resultFactory.ok(undefined);
	} catch (error) {
		return resultFactory.err(
			`copying ${basename(base)}: ${error instanceof Error ? error.message : String(error)} (clone: ${clone.stderr.trim()})`
		);
	}
}

/**
 * expo-updates would compare the embedded manifest (`app.manifest`, `EXUpdates.bundle`) with the bundle it launches
 * and can refuse the new one: the repacked app turns it off in `Expo.plist`, where `EXUpdatesEnabled` is read.
 */
async function disableExpoUpdates(exec: Exec, app: string): AsyncResult<boolean> {
	if (!existsSync(join(app, "EXUpdates.bundle")) && !existsSync(join(app, "app.manifest")))
		return resultFactory.ok(false);
	const plist = join(app, EXPO_PLIST);
	if (!existsSync(plist)) {
		const created = await exec(["plutil", "-create", "xml1", plist]);
		if (created.exitCode !== 0) return resultFactory.err(failure("creating Expo.plist", created));
	}
	const set = await exec(["plutil", "-replace", "EXUpdatesEnabled", "-bool", "false", plist]);
	return set.exitCode === 0
		? resultFactory.ok(true)
		: resultFactory.err(failure("setting EXUpdatesEnabled=false", set));
}

/** The base's entitlements as plist XML, or undefined when it has none (an ad-hoc simulator build usually has an empty dict). */
async function extractEntitlements(exec: Exec, app: string): Promise<string | undefined> {
	const run = await exec(["codesign", "-d", "--entitlements", "-", "--xml", app]);
	if (run.exitCode !== 0 || !run.stdout.includes("<key>")) return undefined;
	return run.stdout.slice(run.stdout.indexOf("<?xml"));
}

/**
 * The iOS half of a repack: clone the simulator base `.app` into `outDir`, swap in the new bundle and assets, and
 * re-sign it ad-hoc keeping its entitlements. `main.jsbundle.map` is written next to the app, not inside it.
 *
 * Only the outer app is re-signed (no `--deep`): its seal covers `main.jsbundle`, assets and `Info.plist`, which
 * changed, while the nested frameworks are untouched and keep their own signatures, which the seal only references.
 */
export const applyIosRepack: ApplyRepack = async ({ exec, baseArtifact, outDir, bundle }) => {
	const app = join(outDir, basename(baseArtifact));
	const baseId = await bundleIdentifier(exec, baseArtifact);
	if (!baseId.success) return baseId;
	const cloned = await cloneApp(exec, baseArtifact, app);
	if (!cloned.success) return cloned;
	try {
		rmSync(join(app, BUNDLE), { force: true });
		copyFileSync(bundle.bundle, join(app, BUNDLE));
		// the bundler's assets-dest is the app root: it writes `assets/…`; stale images must not linger
		rmSync(join(app, "assets"), { recursive: true, force: true });
		for (const name of readdirSync(bundle.assetsDir)) {
			cpSync(join(bundle.assetsDir, name), join(app, name), { recursive: true });
		}
		copyFileSync(bundle.sourcemap, join(outDir, `${BUNDLE}.map`));
	} catch (error) {
		return resultFactory.err(
			`writing the bundle into ${basename(app)}: ${error instanceof Error ? error.message : String(error)}`
		);
	}

	const updates = await disableExpoUpdates(exec, app);
	if (!updates.success) return updates;

	const entitlements = await extractEntitlements(exec, baseArtifact);
	const entitlementsFile = join(outDir, ".entitlements.plist");
	const sign = ["codesign", "--force", "--sign", "-", "--timestamp=none"];
	if (entitlements !== undefined) {
		writeFileSync(entitlementsFile, entitlements);
		sign.push("--entitlements", entitlementsFile);
	}
	const signed = await exec([...sign, app]);
	rmSync(entitlementsFile, { force: true });
	if (signed.exitCode !== 0) return resultFactory.err(failure("codesign", signed));

	const verified = await exec(["codesign", "--verify", "--strict", app]);
	if (verified.exitCode !== 0) return resultFactory.err(failure("the repacked app does not verify", verified));
	const id = await bundleIdentifier(exec, app);
	if (!id.success) return id;
	if (id.data !== baseId.data) return resultFactory.err(`the bundle id changed (${baseId.data} → ${id.data})`);
	const size = existsSync(join(app, BUNDLE)) ? statSync(join(app, BUNDLE)).size : 0;
	if (size === 0) return resultFactory.err(`${BUNDLE} is missing or empty in the repacked app`);
	return resultFactory.ok({ artifact: app });
};
