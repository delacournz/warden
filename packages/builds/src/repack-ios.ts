import { copyFileSync, cpSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Exec } from "@delacour/warden-runtime/exec";
import { type AsyncResult, type Result, resultFactory } from "@delacour/warden-types/result";
import type { ApplyRepack, ApplyRepackInput, ApplyRepackOutput, BundleOutput } from "./repack.types";

const BUNDLE = "main.jsbundle";
const EXPO_PLIST = "Expo.plist";

/**
 * The iOS half of a repack: clone the simulator base `.app` into `outDir`, swap in the new bundle and assets, and
 * re-sign it ad-hoc keeping its entitlements. `main.jsbundle.map` is written next to the app, not inside it.
 *
 * Only the outer app is re-signed (no `--deep`): its seal covers `main.jsbundle`, assets and `Info.plist`, which
 * changed, while the nested frameworks are untouched and keep their own signatures, which the seal only references.
 *
 * Pure apart from the `exec` in each call's input: use the `iosRepacker` singleton. `apply` is an
 * arrow property so it can be passed around as an `ApplyRepack`.
 */
export class IosRepacker {
	readonly apply: ApplyRepack = async ({ exec, baseArtifact, outDir, bundle }) => {
		const app = join(outDir, basename(baseArtifact));
		const baseId = await this.bundleIdentifier(exec, baseArtifact);
		if (!baseId.success) return baseId;
		const cloned = await this.cloneApp(exec, baseArtifact, app);
		if (!cloned.success) return cloned;
		const written = this.writeBundle(app, outDir, bundle);
		if (!written.success) return written;

		const updates = await this.disableExpoUpdates(exec, app);
		if (!updates.success) return updates;

		const signed = await this.resign(exec, { baseArtifact, outDir, app });
		if (!signed.success) return signed;
		return this.verify(exec, app, baseId.data);
	};

	private failure(what: string, run: { stdout: string; stderr: string }): string {
		return `${what}: ${(run.stderr || run.stdout).trim().slice(-1000)}`;
	}

	/** `CFBundleIdentifier` of an `.app`, via `plutil`. */
	private async bundleIdentifier(exec: Exec, app: string): AsyncResult<string> {
		const run = await exec(["plutil", "-extract", "CFBundleIdentifier", "raw", "-o", "-", join(app, "Info.plist")]);
		const id = run.stdout.trim();
		return run.exitCode === 0 && id !== ""
			? resultFactory.ok(id)
			: resultFactory.err(this.failure(`reading CFBundleIdentifier of ${basename(app)}`, run));
	}

	/** Copy the base with APFS clonefiles (`cp -c`, near-free); a plain copy where the volume cannot clone. */
	private async cloneApp(exec: Exec, base: string, target: string): AsyncResult<void> {
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

	private writeBundle(app: string, outDir: string, bundle: BundleOutput): Result<void> {
		try {
			rmSync(join(app, BUNDLE), { force: true });
			copyFileSync(bundle.bundle, join(app, BUNDLE));
			// the bundler's assets-dest is the app root: it writes `assets/…`; stale images must not linger
			rmSync(join(app, "assets"), { recursive: true, force: true });
			for (const name of readdirSync(bundle.assetsDir)) {
				cpSync(join(bundle.assetsDir, name), join(app, name), { recursive: true });
			}
			copyFileSync(bundle.sourcemap, join(outDir, `${BUNDLE}.map`));
			return resultFactory.ok(undefined);
		} catch (error) {
			return resultFactory.err(
				`writing the bundle into ${basename(app)}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	/**
	 * expo-updates would compare the embedded manifest (`app.manifest`, `EXUpdates.bundle`) with the bundle it launches
	 * and can refuse the new one: the repacked app turns it off in `Expo.plist`, where `EXUpdatesEnabled` is read.
	 */
	private async disableExpoUpdates(exec: Exec, app: string): AsyncResult<boolean> {
		if (!existsSync(join(app, "EXUpdates.bundle")) && !existsSync(join(app, "app.manifest")))
			return resultFactory.ok(false);
		const plist = join(app, EXPO_PLIST);
		if (!existsSync(plist)) {
			const created = await exec(["plutil", "-create", "xml1", plist]);
			if (created.exitCode !== 0) return resultFactory.err(this.failure("creating Expo.plist", created));
		}
		const set = await exec(["plutil", "-replace", "EXUpdatesEnabled", "-bool", "false", plist]);
		return set.exitCode === 0
			? resultFactory.ok(true)
			: resultFactory.err(this.failure("setting EXUpdatesEnabled=false", set));
	}

	/** The base's entitlements as plist XML, or undefined when it has none (an ad-hoc simulator build usually has an empty dict). */
	private async extractEntitlements(exec: Exec, app: string): Promise<string | undefined> {
		const run = await exec(["codesign", "-d", "--entitlements", "-", "--xml", app]);
		if (run.exitCode !== 0 || !run.stdout.includes("<key>")) return undefined;
		return run.stdout.slice(run.stdout.indexOf("<?xml"));
	}

	/** Ad-hoc re-sign the outer app, keeping the base's entitlements. */
	private async resign(
		exec: Exec,
		paths: Pick<ApplyRepackInput, "baseArtifact" | "outDir"> & { app: string }
	): AsyncResult<void> {
		const entitlements = await this.extractEntitlements(exec, paths.baseArtifact);
		const entitlementsFile = join(paths.outDir, ".entitlements.plist");
		const sign = ["codesign", "--force", "--sign", "-", "--timestamp=none"];
		if (entitlements !== undefined) {
			writeFileSync(entitlementsFile, entitlements);
			sign.push("--entitlements", entitlementsFile);
		}
		const signed = await exec([...sign, paths.app]);
		rmSync(entitlementsFile, { force: true });
		if (signed.exitCode !== 0) return resultFactory.err(this.failure("codesign", signed));
		return resultFactory.ok(undefined);
	}

	/** The signature verifies, the bundle id is the base's and the bundle is non-empty. */
	private async verify(exec: Exec, app: string, baseId: string): AsyncResult<ApplyRepackOutput> {
		const verified = await exec(["codesign", "--verify", "--strict", app]);
		if (verified.exitCode !== 0) return resultFactory.err(this.failure("the repacked app does not verify", verified));
		const id = await this.bundleIdentifier(exec, app);
		if (!id.success) return id;
		if (id.data !== baseId) return resultFactory.err(`the bundle id changed (${baseId} → ${id.data})`);
		const size = existsSync(join(app, BUNDLE)) ? statSync(join(app, BUNDLE)).size : 0;
		if (size === 0) return resultFactory.err(`${BUNDLE} is missing or empty in the repacked app`);
		return resultFactory.ok({ artifact: app });
	}
}

export const iosRepacker = new IosRepacker();
