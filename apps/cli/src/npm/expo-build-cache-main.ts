import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createProvider, type WardenRun } from "./expo-build-cache";

/**
 * `<pkg>/bin/warden.mjs` (`SHIM_PATH`; the entry test holds them together). The package finds itself through its own
 * name: the bundler freezes `__dirname` / `module.filename` to the build machine's path, so they cannot be used.
 */
function shimPath(): string | undefined {
	try {
		return join(dirname(require.resolve("@delacour/warden/package.json")), "bin", "warden.mjs");
	} catch {
		return undefined;
	}
}

/** A fingerprint of a fresh checkout and a copy of an app can take a while; a hung warden must not hang Expo forever. */
const TIMEOUT_MS = 10 * 60_000;

/**
 * Run warden through this package's own shim under the node running Expo, else `warden` from PATH. stdout is the
 * `--json` document; stderr is kept for the warning, never forwarded.
 */
function runWarden(args: readonly string[], cwd: string): Promise<WardenRun> {
	const shim = shimPath();
	const [command, prefix]: [string, string[]] =
		shim !== undefined && existsSync(shim) ? [process.execPath, [shim]] : ["warden", []];
	return new Promise((resolve) => {
		const child = spawn(command, [...prefix, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		// spawn's own `timeout` option never clears its timer when the command is missing (no exit event): that would hold Expo open
		const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
		const settle = (run: WardenRun) => {
			clearTimeout(timer);
			resolve(run);
		};
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) =>
			settle({ exitCode: null, stdout, stderr, failure: `could not run warden (${error.message})` })
		);
		child.on("close", (exitCode, signal) =>
			settle({ exitCode, stdout, stderr, ...(signal ? { failure: `warden was stopped by ${signal}` } : {}) })
		);
	});
}

const provider = createProvider({
	run: runWarden,
	log: (message) => console.log(message),
	warn: (message) => console.warn(message),
});

export const { calculateFingerprintHash, resolveBuildCache, uploadBuildCache } = provider;
export default provider;
