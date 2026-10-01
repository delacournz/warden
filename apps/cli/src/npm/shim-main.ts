#!/usr/bin/env node
/**
 * The `warden` bin of the npm package, bundled for node into `bin/warden.mjs` by
 * `scripts/npm-packages.ts`: find this platform's binary and run it with the same argv, stdio and exit code.
 */
import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { locateBinary } from "./shim";

const require = createRequire(import.meta.url);

/** Tarballs can lose the executable bit on some package managers; restore it when we can. */
function ensureExecutable(path: string): void {
	try {
		accessSync(path, constants.X_OK);
	} catch {
		try {
			chmodSync(path, 0o755);
		} catch {}
	}
}

const binary = locateBinary({
	platform: process.platform,
	arch: process.arch,
	env: process.env,
	resolvePackageJson: (name) => require.resolve(`${name}/package.json`),
});
if (!binary.success) {
	process.stderr.write(`${binary.error}\n`);
	process.exit(1);
}
ensureExecutable(binary.data);
const child = spawnSync(binary.data, process.argv.slice(2), { stdio: "inherit" });
if (child.error) {
	process.stderr.write(`@delacour/warden: could not run ${binary.data}: ${child.error.message}\n`);
	process.exit(1);
}
if (child.signal) process.kill(process.pid, child.signal);
process.exit(child.status ?? 1);
