import type {
	ExpoBuildCacheProps,
	ExpoBuildCacheProvider,
	ExpoFingerprintedProps,
	ExpoUploadProps,
} from "./expo-build-cache.types";

/** What a `warden` run left behind; `failure` is set when the process never produced an exit code (not found, timed out). */
export type WardenRun = { exitCode: number | null; stdout: string; stderr: string; failure?: string };

/** Outside world for the provider, injectable for tests. It runs in Expo's Node process, so no warden code is imported. */
export type ProviderDeps = {
	/** run `warden <args>` in `cwd` */
	run: (args: readonly string[], cwd: string) => Promise<WardenRun>;
	log: (message: string) => void;
	warn: (message: string) => void;
};

/** `builds path` exits with this when nothing is cached (mirrors `PATH_MISS_EXIT` in `commands/builds.ts`). */
const MISS_EXIT = 2;

const PREFIX = "warden:";

type Document = Record<string, unknown>;

function parseDocument(stdout: string): Document | undefined {
	try {
		const doc: unknown = JSON.parse(stdout);
		return typeof doc === "object" && doc !== null && !Array.isArray(doc) ? (doc as Document) : undefined;
	} catch {
		return undefined;
	}
}

/** The reason a run failed, one line: its failure, else the first stderr line, else the exit code. */
function reason(run: WardenRun): string {
	if (run.failure !== undefined) return run.failure;
	const line = run.stderr.split("\n").find((l) => l.trim() !== "");
	return line?.trim() ?? `exit ${run.exitCode}`;
}

const isDebug = (configuration: string | undefined) =>
	configuration === undefined || configuration.toLowerCase().includes("debug");

/**
 * Expo's build cache provider backed by warden's machine-wide dev build: `expo run:ios` (Debug, simulator) in any
 * checkout reuses the dev build `warden app ensure --kind dev` made, and a local build is filed into warden's cache.
 * It takes part only when the project's plain native build is warden's default dev build, so a variant, a custom build
 * command or kind settings (a binary that could differ) leave the run to Expo. Never throws into Expo: every
 * problem is one `warden:` warning and a null.
 */
export function createProvider(deps: ProviderDeps): ExpoBuildCacheProvider {
	const { run, log, warn } = deps;

	async function wardenJson(args: readonly string[], cwd: string): Promise<{ run: WardenRun; doc?: Document }> {
		const result = await run(args, cwd).catch(
			(error: unknown): WardenRun => ({
				exitCode: null,
				stdout: "",
				stderr: "",
				failure: error instanceof Error ? error.message : String(error),
			})
		);
		const doc = result.failure === undefined ? parseDocument(result.stdout) : undefined;
		return { run: result, ...(doc ? { doc } : {}) };
	}

	return {
		async calculateFingerprintHash({ projectRoot, platform, runOptions }: ExpoBuildCacheProps) {
			if (platform !== "ios" || !isDebug(runOptions.configuration)) return null;
			const { run: result, doc } = await wardenJson(["builds", "path", "ios", "--kind", "dev", "--json"], projectRoot);
			const answered = result.exitCode === 0 || result.exitCode === MISS_EXIT;
			if (!answered || doc === undefined || typeof doc.hash !== "string") {
				warn(`${PREFIX} build cache skipped, warden could not fingerprint the project: ${reason(result)}`);
				return null;
			}
			if (doc.defaultBuild !== true) {
				log(
					`${PREFIX} build cache skipped, this project's native build is not warden's default dev build (variant, custom build command or kinds.dev settings)`
				);
				return null;
			}
			return doc.hash;
		},

		async resolveBuildCache({ projectRoot, platform, fingerprintHash }: ExpoFingerprintedProps) {
			if (platform !== "ios") return null;
			const { run: result, doc } = await wardenJson(
				["builds", "path", "ios", "--kind", "dev", "--hash", fingerprintHash, "--json"],
				projectRoot
			);
			if (result.exitCode === 0 && doc?.found === true && typeof doc.path === "string") {
				log(`${PREFIX} using the cached dev build ${doc.path}`);
				return doc.path;
			}
			if (result.exitCode === MISS_EXIT) {
				log(`${PREFIX} no cached dev build for this project yet, building`);
				return null;
			}
			warn(`${PREFIX} could not look up the cached dev build: ${reason(result)}`);
			return null;
		},

		async uploadBuildCache({ projectRoot, platform, fingerprintHash, buildPath }: ExpoUploadProps) {
			if (platform !== "ios") return null;
			const { run: result, doc } = await wardenJson(
				["builds", "import", buildPath, "--kind", "dev", "--hash", fingerprintHash, "--json"],
				projectRoot
			);
			if (result.exitCode === 0 && typeof doc?.path === "string") {
				log(`${PREFIX} stored the dev build in warden's cache: ${doc.path}`);
				return doc.path;
			}
			warn(`${PREFIX} could not store the dev build: ${reason(result)}`);
			return null;
		},
	};
}
