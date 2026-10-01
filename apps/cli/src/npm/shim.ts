import { dirname, join } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { NPM_PACKAGE, platformPackageName, releaseTarget } from "./platforms";

/** Outside world for the npm `warden` shim, injectable for tests. */
export type ShimDeps = {
	platform: string;
	arch: string;
	env: Record<string, string | undefined>;
	/** `require.resolve("<name>/package.json")` from the shim; throws when the package isn't installed */
	resolvePackageJson: (name: string) => string;
};

const SOURCE_HINT = "build from source instead: https://github.com/delacournz/warden#install";

/** The compiled binary this machine should run: `$WARDEN_BINARY`, else `<platform package>/bin/warden`. */
export function locateBinary(deps: ShimDeps): Result<string> {
	if (deps.env.WARDEN_BINARY) return ok(deps.env.WARDEN_BINARY);
	const target = releaseTarget(deps.platform, deps.arch);
	if (!target.success) return err(`${NPM_PACKAGE}: ${target.error} — ${SOURCE_HINT}`);
	const name = platformPackageName(target.data);
	try {
		return ok(join(dirname(deps.resolvePackageJson(name)), "bin", "warden"));
	} catch {
		return err(
			`${NPM_PACKAGE}: ${name} is not installed. It's an optional dependency; reinstall without --omit=optional / --no-optional (e.g. \`npm i -g ${NPM_PACKAGE}\`), or ${SOURCE_HINT}`
		);
	}
}
