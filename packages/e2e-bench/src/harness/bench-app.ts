import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { z } from "zod";
import { type Platform, platformSchema } from "../results/schema";
import { appFingerprint, parseEnsure } from "./app";
import { BUNDLE_ID } from "./bundle";
import { type Exec, runOk } from "./exec";

/**
 * The pinned bench app: one build of `apps/example` copied to `<repoRoot>/.bench/app/<platform>/` next to
 * a `manifest.json`, built once and installed by every `bench run` until rebuilt. A run never fingerprints,
 * builds or consults EAS inside the benchmark session.
 */

const SOURCES = ["cache", "eas", "build", "import"] as const;
export type BenchAppSource = (typeof SOURCES)[number];

export const benchAppManifestSchema = z.object({
	schemaVersion: z.literal(1),
	platform: platformSchema,
	bundleId: z.string(),
	/** the artifact's file or directory name inside the bench app dir */
	artifact: z.string().min(1),
	/** warden's fingerprint of the project, or `import:<sha256 prefix>` for a bare path */
	hash: z.string(),
	sha256: z.string(),
	bytes: z.number().int().nonnegative(),
	source: z.enum(SOURCES),
	builtAt: z.string(),
	commit: z.string().optional(),
});
export type BenchAppManifest = z.infer<typeof benchAppManifestSchema>;

export type BenchApp = { manifest: BenchAppManifest; appPath: string };

/** The filesystem calls the export makes, injectable for tests. */
export type BenchAppFs = {
	cpSync: typeof cpSync;
	rmSync: typeof rmSync;
	renameSync: typeof renameSync;
	writeFileSync: typeof writeFileSync;
	mkdirSync: typeof mkdirSync;
};

const realFs: BenchAppFs = { cpSync, rmSync, renameSync, writeFileSync, mkdirSync };

const MANIFEST = "manifest.json";
const PROJECT = "apps/example";
const VARIANT = "bench";

export function benchAppDir(repoRoot: string, platform: Platform): string {
	return join(repoRoot, ".bench", "app", platform);
}

/** Reads `<dir>/manifest.json` and checks the artifact it names exists. */
export function readBenchApp(dir: string): Result<BenchApp> {
	const manifestPath = join(dir, MANIFEST);
	const platform = basename(dir);
	if (!existsSync(manifestPath))
		return err(`no bench app at ${dir} — run \`bun run bench app build --platform ${platform}\``);
	try {
		const manifest = benchAppManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
		const appPath = join(dir, manifest.artifact);
		if (!existsSync(appPath)) return err(`bench app at ${dir}: artifact ${manifest.artifact} is missing — rebuild`);
		return ok({ manifest, appPath });
	} catch (e) {
		return err(`bench app manifest ${manifestPath}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** The artifact on disk must still be the bytes that were pinned. */
export function verifyBenchApp(app: BenchApp): Result<void> {
	const print = appFingerprint(app.appPath);
	if (!print.success) return err(`bench app fingerprint: ${print.error}`);
	if (print.data.sha256 === app.manifest.sha256 && print.data.bytes === app.manifest.bytes) return ok(undefined);
	return err(
		`bench app at ${dirname(app.appPath)} changed since it was built (sha ${app.manifest.sha256.slice(0, 12)}≠${print.data.sha256.slice(0, 12)}) — rebuild`
	);
}

export type ExportInput = {
	/** the `.app` directory or `.apk` file to pin */
	from: string;
	platform: Platform;
	bundleId: string;
	hash: string;
	source: BenchAppSource;
	dir: string;
	now: () => Date;
	commit?: string;
};

/** Copies the artifact into `<dir>.tmp` with its manifest, then swaps the tmp dir in for `dir`. */
export async function exportBenchApp(input: ExportInput, fs: BenchAppFs = realFs): AsyncResult<BenchApp> {
	const tmp = `${input.dir}.tmp`;
	const artifact = basename(input.from);
	try {
		fs.rmSync(tmp, { recursive: true, force: true });
		fs.mkdirSync(tmp, { recursive: true });
		fs.cpSync(input.from, join(tmp, artifact), { recursive: true, verbatimSymlinks: true });
		const print = appFingerprint(join(tmp, artifact));
		if (!print.success) throw new Error(String(print.error));
		const manifest: BenchAppManifest = {
			schemaVersion: 1,
			platform: input.platform,
			bundleId: input.bundleId,
			artifact,
			hash: input.hash,
			sha256: print.data.sha256,
			bytes: print.data.bytes,
			source: input.source,
			builtAt: input.now().toISOString(),
			...(input.commit !== undefined ? { commit: input.commit } : {}),
		};
		fs.writeFileSync(join(tmp, MANIFEST), `${JSON.stringify(manifest, null, "\t")}\n`);
		fs.rmSync(input.dir, { recursive: true, force: true });
		fs.renameSync(tmp, input.dir);
		return ok({ manifest, appPath: join(input.dir, artifact) });
	} catch (e) {
		fs.rmSync(tmp, { recursive: true, force: true });
		return err(`bench app export: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** Pins a bare `.app` / `.apk` the user points at (`bench run --app <path>`). */
export async function importBenchApp(
	input: { path: string; platform: Platform; dir: string; now: () => Date },
	fs: BenchAppFs = realFs
): AsyncResult<BenchApp> {
	const print = appFingerprint(input.path);
	if (!print.success) return err(`app fingerprint: ${print.error}`);
	return exportBenchApp(
		{
			from: input.path,
			platform: input.platform,
			bundleId: BUNDLE_ID,
			hash: `import:${print.data.sha256.slice(0, 12)}`,
			source: "import",
			dir: input.dir,
			now: input.now,
		},
		fs
	);
}

export type EnsureBenchAppInput = {
	platform: Platform;
	repoRoot: string;
	cliPath: string;
	/** rebuild even when a bench app exists */
	force: boolean;
	/** let warden fetch an EAS build instead of building locally */
	eas: boolean;
	now: () => Date;
	log: (line: string) => void;
};

async function headCommit(exec: Exec, repoRoot: string): Promise<string | undefined> {
	const ran = await exec.run("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
	const sha = ran.stdout.trim();
	return ran.code === 0 && sha !== "" ? sha : undefined;
}

function isSource(value: string): value is BenchAppSource {
	return SOURCES.some((s) => s === value);
}

/** Reuses the pinned app; builds and pins it (`warden app ensure --no-install`) when missing or `force`. */
export async function ensureBenchApp(
	exec: Exec,
	input: EnsureBenchAppInput
): AsyncResult<BenchApp & { reused: boolean }> {
	const dir = benchAppDir(input.repoRoot, input.platform);
	if (!input.force) {
		const existing = readBenchApp(dir);
		if (existing.success) return ok({ ...existing.data, reused: true });
	}
	const args = [
		input.cliPath,
		"app",
		"ensure",
		input.platform,
		"--project",
		join(input.repoRoot, PROJECT),
		"--variant",
		VARIANT,
		"--no-install",
		...(input.eas ? [] : ["--no-eas"]),
		"--json",
	];
	const ran = await runOk(exec, process.execPath, args, { onLine: (_s, line) => input.log(line) });
	if (!ran.success) return ran;
	const ensured = parseEnsure(ran.data.stdout);
	if (ensured === undefined) return err(`warden app ensure: unparseable output: ${ran.data.stdout.slice(0, 200)}`);
	if (ensured.appPath === "") return err("warden app ensure returned no artifact path: nothing to pin");
	const commit = await headCommit(exec, input.repoRoot);
	const exported = await exportBenchApp({
		from: ensured.appPath,
		platform: input.platform,
		bundleId: BUNDLE_ID,
		hash: ensured.hash,
		source: isSource(ensured.source) && ensured.source !== "import" ? ensured.source : "cache",
		dir,
		now: input.now,
		...(commit !== undefined ? { commit } : {}),
	});
	return exported.success ? ok({ ...exported.data, reused: false }) : exported;
}

export type BenchAppStatus =
	| { state: "missing" }
	| { state: "fresh" | "stale" | "unknown"; manifest: BenchAppManifest; appPath: string; currentHash?: string };

function currentFingerprint(stdout: string, platform: Platform): string | undefined {
	try {
		const raw: unknown = JSON.parse(stdout);
		if (typeof raw !== "object" || raw === null) return undefined;
		const prints = (raw as { fingerprints?: unknown }).fingerprints;
		if (typeof prints !== "object" || prints === null) return undefined;
		const value = (prints as Record<string, unknown>)[platform];
		return typeof value === "string" ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Compares the pinned app's hash with the project's current fingerprint. */
export async function benchAppStatus(
	exec: Exec,
	input: { platform: Platform; repoRoot: string; cliPath: string }
): AsyncResult<BenchAppStatus> {
	const app = readBenchApp(benchAppDir(input.repoRoot, input.platform));
	if (!app.success) return ok({ state: "missing" });
	const base = { manifest: app.data.manifest, appPath: app.data.appPath };
	if (app.data.manifest.hash.startsWith("import:")) return ok({ state: "unknown", ...base });
	const ran = await runOk(exec, process.execPath, [
		input.cliPath,
		"app",
		"fingerprint",
		input.platform,
		"--project",
		join(input.repoRoot, PROJECT),
		"--variant",
		VARIANT,
		"--json",
	]);
	const current = ran.success ? currentFingerprint(ran.data.stdout, input.platform) : undefined;
	if (current === undefined) return ok({ state: "unknown", ...base });
	return ok({ state: current === app.data.manifest.hash ? "fresh" : "stale", ...base, currentHash: current });
}

export function cleanBenchApp(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
	rmSync(`${dir}.tmp`, { recursive: true, force: true });
}
