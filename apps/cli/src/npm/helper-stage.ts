import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import {
	HELPER_BINARY,
	HELPER_GUEST,
	HELPER_INJECT,
	HELPER_MANIFEST,
	HELPER_RESOURCES,
	npmHelper,
	type StagedHelper,
} from "./helper";

export class HelperStage {
	/** Names of the `*.framework` directories directly inside `dir`, sorted. */
	private frameworkNames(dir: string): string[] {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.name.endsWith(".framework") && (entry.isDirectory() || entry.isSymbolicLink()))
			.map((entry) => entry.name)
			.sort();
	}

	/**
	 * Copy the built helper (`packages/driver-ios/native/dist`: `warden-simd`, `Resources/`, `*.framework`, `manifest.json`)
	 * into a platform package's `bin/`. No `warden-simd` in `distDir` → `undefined`, or an error with `required`
	 * (the release build; there the injected dylib is required too). A dist that has a binary but is incomplete is always an error: never ship half a helper.
	 * Symlinks inside the frameworks are copied as symlinks (`verbatimSymlinks`). `npm pack` drops them, which is fine:
	 * `warden-simd` links `@rpath/<Name>.framework/Versions/A/<Name>`, a real file, and the helper runs from an
	 * extracted tarball (checked on the 0.1.0 release build, `doctor` sim-helper-health ok).
	 */
	stageHelper(input: { distDir: string; binDir: string; required: boolean }): Result<StagedHelper | undefined> {
		const { distDir, binDir, required } = input;
		if (!existsSync(join(distDir, HELPER_BINARY))) {
			return required
				? resultFactory.err(
						`--require-helper: no ${HELPER_BINARY} in ${distDir} — run \`bun run --cwd packages/driver-ios native:deps && native:build\``
					)
				: resultFactory.ok(undefined);
		}
		if (!existsSync(join(distDir, HELPER_GUEST)))
			return resultFactory.err(`${distDir} has ${HELPER_BINARY} but no ${HELPER_GUEST}`);
		const manifestPath = join(distDir, HELPER_MANIFEST);
		if (!existsSync(manifestPath))
			return resultFactory.err(`${distDir} has ${HELPER_BINARY} but no ${HELPER_MANIFEST}`);
		const info = npmHelper.parseHelperManifest(readFileSync(manifestPath, "utf8"));
		if (!info.success) return info;
		const frameworks = this.frameworkNames(distDir);
		if (frameworks.length === 0) return resultFactory.err(`${distDir} has ${HELPER_BINARY} but no stub *.framework`);

		const inject = existsSync(join(distDir, HELPER_INJECT));
		if (required && !inject) {
			return resultFactory.err(
				`--require-helper: no ${HELPER_INJECT} in ${distDir} — run \`bun run --cwd packages/e2e native:build\` (it builds the injected dylib after the helper)`
			);
		}

		mkdirSync(binDir, { recursive: true });
		const copy = (name: string) =>
			cpSync(join(distDir, name), join(binDir, name), { recursive: true, verbatimSymlinks: true });
		copy(HELPER_BINARY);
		copy(HELPER_RESOURCES);
		copy(HELPER_MANIFEST);
		for (const framework of frameworks) copy(framework);
		if (inject) copy(HELPER_INJECT);
		chmodSync(join(binDir, HELPER_BINARY), 0o755);
		return resultFactory.ok({ ...info.data, frameworks, inject });
	}
}

export const helperStage = new HelperStage();
