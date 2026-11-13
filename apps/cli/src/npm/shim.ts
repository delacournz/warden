import { dirname, join } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { NPM_PACKAGE, platformPackageName, releaseTarget } from "./platforms";

/** Outside world for the npm `warden` shim, injectable for tests. */
export type ShimDeps = {
	platform: string;
	arch: string;
	env: Record<string, string | undefined>;
	/** the directory of the shim file as it was run (`<prefix>/bin` when a cache copied it out of its package) */
	scriptDir: string;
	/**
	 * `require.resolve("<name>/package.json")` from the shim, or from `paths` when given; throws when the package
	 * isn't installed
	 */
	resolvePackageJson: (name: string, paths?: readonly string[]) => string;
};

const SOURCE_HINT = "build from source instead: https://github.com/delacournz/warden#install";

/** The compiled binary this machine should run: `$WARDEN_BINARY`, else `<platform package>/bin/warden`. */
export function locateBinary(deps: ShimDeps): Result<string> {
	if (deps.env.WARDEN_BINARY) return ok(deps.env.WARDEN_BINARY);
	const target = releaseTarget(deps.platform, deps.arch);
	if (!target.success) return err(`${NPM_PACKAGE}: ${target.error} — ${SOURCE_HINT}`);
	const name = platformPackageName(target.data);
	// Beside the shim's real path first. A cache that stores files, not symlinks (EAS Workflows' eas/save_cache), turns
	// npm's `<prefix>/bin/warden` link into a copy that resolves from `<prefix>/bin`: look in the global install too.
	const searches = [undefined, [join(deps.scriptDir, "..", "lib", "node_modules", NPM_PACKAGE)]];
	for (const paths of searches) {
		try {
			return ok(join(dirname(deps.resolvePackageJson(name, paths)), "bin", "warden"));
		} catch {}
	}
	return err(
		`${NPM_PACKAGE}: ${name} is not installed. It's an optional dependency; reinstall without --omit=optional / --no-optional (e.g. \`npm i -g ${NPM_PACKAGE}\`), or ${SOURCE_HINT}`
	);
}
