import {
	closeSync,
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import type { Exec } from "../exec";
import { findNodeBin } from "../node-bin";
import type { Platform } from "../types";
import { baseIdentity } from "./base-identity";
import {
	adoptKindDir,
	diskSize,
	findRepack,
	findSimulatorBase,
	forgetInstallsAt,
	kindHash,
	recordRepack,
	repackDir,
	touchBuild,
} from "./cache";
import { type EnsureKindInput, ensureKindBuild, LOCAL_PROFILE } from "./ensure";
import { type GitContext, gitContext, readRepackMeta, writeRepackMeta } from "./js-key";
import { computeKindKey, type KindKeys } from "./kind-key";
import { type BuildLockDeps, buildLockKey, withBuildLock } from "./lock";
import type { ApplyRepack, BundleOutput } from "./repack.types";
import { androidKeepsSigner } from "./repack-android";

/** The first bytes of Hermes bytecode (`0x1f1903c103bc1fc6` little-endian). */
const HBC_MAGIC = Uint8Array.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]);

/**
 * Why a cached repack was not reused: its simulator base was replaced since (`base-changed`), it was made before
 * warden recorded which base it came from (`base-unrecorded`, once), or it is signed by another key than its base so a
 * device holding the base could not update to it (`signer-changed`, Android).
 */
export type RepackReason = "base-changed" | "base-unrecorded" | "signer-changed";

/** What `repackApp` produced: a cached repack (reused or just made), or why a full simulator build is needed instead. */
export type RepackResult =
	| {
			kind: "reused" | "repacked";
			/** `repacked` over a cached repack that could not be reused; absent on a first repack or a `force` */
			reason?: RepackReason;
			/** the repacked `.app` / `.apk` */
			artifact: string;
			/** the cache / install hash of the repack (`kindHash`) */
			hash: string;
			/** the simulator base it was cloned from */
			baseHash: string;
			jsKey: string;
			/** bundle + Hermes compile time; absent when a reused repack has no readable `meta.json` */
			bundleMs?: number;
			/** `repacked` only: the Android base built in this run embeds this JS, so its apk is the repack (no bundle ran) */
			fromBase?: true;
	  }
	| { kind: "fallback"; reason: string };

export type RepackInput = Omit<EnsureKindInput, "key" | "buildKey" | "deviceId" | "native" | "hash"> & {
	/** the platform halves, `applyIosRepack` / `applyAndroidRepack` */
	repackers: Record<Platform, ApplyRepack>;
	/** rebuild even when this JS is cached (a concurrent run that finished while this one waited still counts) */
	force?: boolean;
	/** is Hermes on in the base? default `detectHermes` */
	hermes?: (exec: Exec, platform: Platform, baseArtifact: string) => Promise<boolean>;
	/** where scratch dirs go (default the OS temp dir) */
	scratchRoot?: string;
	/** is the cached repack signed by its base's key? default: Android compares the apks' certificates, iOS true */
	keepsSigner?: (platform: Platform, baseArtifact: string, repackArtifact: string) => Promise<boolean>;
	/** finds or builds the simulator base; default `ensureKindBuild` */
	ensureBase?: typeof ensureKindBuild;
};

type Env = Record<string, string | undefined>;

const BUNDLE_FILE: Record<Platform, string> = { ios: "main.jsbundle", android: "index.android.bundle" };

/**
 * The entry file Expo / RN would bundle: `package.json` `main` (a file, or a module such as `expo-router/entry`),
 * else `index.{js,ts,tsx,jsx}`. Absolute.
 */
export function resolveEntryFile(root: string, exists: (path: string) => boolean = existsSync): string | undefined {
	const main = packageMain(root);
	if (main === undefined) {
		return ["index.js", "index.ts", "index.tsx", "index.jsx"].map((name) => join(root, name)).find(exists);
	}
	const direct = join(root, main);
	if (exists(direct) && statSync(direct).isFile()) return direct;
	const withExt = [".js", ".ts", ".tsx", ".jsx"].map((ext) => direct + ext).find(exists);
	if (withExt) return withExt;
	try {
		return createRequire(join(root, "package.json")).resolve(main);
	} catch {
		return undefined;
	}
}

/** `package.json` `main`, when it names one. */
function packageMain(root: string): string | undefined {
	try {
		const main = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { main?: unknown }).main;
		return typeof main === "string" && main !== "" ? main : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The bundler flags that shape the bundle and not where it is written: the `bundlerFlags` of `computeKindKey` (so
 * they are in the JS key). The entry is root-relative so two checkouts of one commit share a key.
 */
export function bundlerFlags(platform: Platform, framework: "expo" | "react-native", entryRel: string): string[] {
	return [
		framework === "expo" ? "export:embed" : "bundle",
		"--platform",
		platform,
		"--dev",
		"false",
		"--minify",
		"true",
		"--entry-file",
		entryRel,
		"--reset-cache",
	];
}

/** The bundler argv: `bundlerFlags` plus the scratch output paths. */
export function bundleArgv(
	bin: string,
	flags: readonly string[],
	entry: string,
	platform: Platform,
	scratch: string
): string[] {
	const [command = "", ...rest] = flags;
	const bundle = join(scratch, BUNDLE_FILE[platform]);
	const resolved = rest.map((flag, i) => (rest[i - 1] === "--entry-file" ? entry : flag));
	return [
		bin,
		command,
		...resolved,
		"--bundle-output",
		bundle,
		"--assets-dest",
		join(scratch, "assets"),
		"--sourcemap-output",
		`${bundle}.map`,
	];
}

/** `hermesc` of the worktree: RN 0.86 ships it in `hermes-compiler`, older RN in `react-native/sdks/hermesc`. */
export function findHermesc(
	root: string,
	hostBin: string = process.platform === "linux" ? "linux64-bin" : "osx-bin",
	exists: (path: string) => boolean = existsSync
): string | undefined {
	for (let dir = root; ; dir = dirname(dir)) {
		for (const candidate of [
			join(dir, "node_modules", "hermes-compiler", "hermesc", hostBin, "hermesc"),
			join(dir, "node_modules", "react-native", "sdks", "hermesc", hostBin, "hermesc"),
		]) {
			if (exists(candidate)) return candidate;
		}
		if (dirname(dir) === dir) return undefined;
	}
}

/** `node_modules/react-native/scripts/compose-source-maps.js` nearest to `root`. */
function findComposeScript(root: string, exists: (path: string) => boolean = existsSync): string | undefined {
	for (let dir = root; ; dir = dirname(dir)) {
		const script = join(dir, "node_modules", "react-native", "scripts", "compose-source-maps.js");
		if (exists(script)) return script;
		if (dirname(dir) === dir) return undefined;
	}
}

/**
 * Is the base built with Hermes? iOS: `Frameworks/hermesvm.framework` (RN 0.86; `hermes.framework` before) in the
 * `.app`. Android: a `lib/<abi>/libhermes*.so` entry in the apk.
 */
export async function detectHermes(exec: Exec, platform: Platform, baseArtifact: string): Promise<boolean> {
	if (platform === "ios") {
		return ["hermesvm.framework", "hermes.framework"].some((name) =>
			existsSync(join(baseArtifact, "Frameworks", name))
		);
	}
	const listing = await exec(["unzip", "-Z1", baseArtifact]);
	return listing.exitCode === 0 && /^lib\/[^/]+\/libhermes[^/]*\.so$/m.test(listing.stdout);
}

/** Does `file` start with the Hermes bytecode magic? */
export function hasHbcMagic(file: string): boolean {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const head = new Uint8Array(HBC_MAGIC.length);
		const read = readSync(fd, head, 0, head.length, 0);
		return read === head.length && head.every((byte, i) => byte === HBC_MAGIC[i]);
	} catch {
		return false;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

type BundleStep = {
	exec: Exec;
	root: string;
	platform: Platform;
	framework: "expo" | "react-native";
	flags: readonly string[];
	entry: string;
	env: Env;
	scratch: string;
	hermes: boolean;
	log: (line: string) => void;
	output?: (line: string) => void;
};

/** Hermes-compile `bundle` (hermesc, then the composed source map) into the scratch dir. */
async function compileHermes(step: BundleStep, bundle: string, assetsDir: string): AsyncResult<BundleOutput> {
	const { exec, root, scratch } = step;
	const hermesc = findHermesc(root);
	if (!hermesc) return err(`repack: Hermes is on in the base but hermesc was not found under ${root}/node_modules`);
	const hbc = join(scratch, `${basename(bundle)}.hbc`);
	step.log("compiling Hermes bytecode");
	const compile = await exec([hermesc, "-emit-binary", "-O", "-output-source-map", "-out", hbc, bundle], { cwd: root });
	if (compile.exitCode !== 0)
		return err(`repack: hermesc failed: ${(compile.stderr || compile.stdout).trim().slice(-2000)}`);
	if (!hasHbcMagic(hbc)) return err("repack: hermesc output is not Hermes bytecode (bad magic bytes)");
	let sourcemap = `${bundle}.map`;
	const compose = findComposeScript(root);
	if (compose && existsSync(`${hbc}.map`)) {
		const composed = join(scratch, `${basename(bundle)}.composed.map`);
		const merged = await exec(["node", compose, `${bundle}.map`, `${hbc}.map`, "-o", composed], { cwd: root });
		if (merged.exitCode === 0 && existsSync(composed)) sourcemap = composed;
		else step.log("composing source maps failed: keeping the JS source map");
	}
	return ok({ bundle: hbc, assetsDir, sourcemap, hermes: true });
}

/** The bundler's plain JS output in the scratch dir, before any Hermes compile. */
type RawBundle = { bundle: string; assetsDir: string };

/** Run the bundler (Metro via `expo export:embed` / `react-native bundle`) into `scratch`. Needs no base. */
async function runBundler(step: Omit<BundleStep, "hermes">): AsyncResult<RawBundle> {
	const { exec, root, platform, scratch } = step;
	const binName = step.framework === "expo" ? "expo" : "react-native";
	const bin = findNodeBin(root, binName);
	if (!bin) return err(`repack: no ${binName} binary under ${root}/node_modules/.bin (install dependencies)`);
	const bundle = join(scratch, BUNDLE_FILE[platform]);
	const argv = bundleArgv(bin, step.flags, step.entry, platform, scratch);
	step.log(`bundling ${platform} JS (${binName} ${argv[1]})`);
	const run = await exec(argv, {
		cwd: root,
		env: step.env,
		...(step.output ? { onLine: step.output } : {}),
	});
	if (run.exitCode !== 0)
		return err(`repack: ${binName} ${argv[1]} failed: ${(run.stderr || run.stdout).trim().slice(-2000)}`);
	if (!existsSync(bundle) || statSync(bundle).size === 0)
		return err(`repack: the bundler wrote no ${basename(bundle)}`);
	const assetsDir = join(scratch, "assets");
	mkdirSync(assetsDir, { recursive: true });
	return ok({ bundle, assetsDir });
}

/** The bundle as the repacker takes it: Hermes-compiled when the base runs Hermes, else the plain JS. */
function finishBundle(step: BundleStep, raw: RawBundle): AsyncResult<BundleOutput> {
	if (!step.hermes) return Promise.resolve(ok({ ...raw, sourcemap: `${raw.bundle}.map`, hermes: false }));
	return compileHermes(step, raw.bundle, raw.assetsDir);
}

/**
 * The bundler run while the simulator base builds: it needs only the worktree's JS, so it overlaps the native build
 * instead of following it. Its own scratch dir, quiet (the build's output is what streams); the Hermes compile waits
 * for the base, which says whether Hermes is on.
 */
type EarlyBundle = {
	scratch: string;
	startedAt: number;
	done: Promise<{ raw: Result<RawBundle, string>; endedAt: number }>;
};

/**
 * Why a cached repack cannot be reused over `basePath`, if it cannot: it is valid over the exact base it was cloned
 * from, and signed by that base's key. A pruned base is never passed here, the repack stays usable then.
 */
async function staleReason(
	input: RepackInput,
	basePath: string,
	repackPath: string,
	recordedBase: string | undefined
): Promise<RepackReason | undefined> {
	const { platform, exec } = input;
	const current = await baseIdentity(platform, basePath);
	if (current !== undefined && recordedBase !== current)
		return recordedBase === undefined ? "base-unrecorded" : "base-changed";
	const keeps =
		input.keepsSigner ?? ((p, b, r) => (p === "android" ? androidKeepsSigner(exec, b, r) : Promise.resolve(true)));
	return (await keeps(platform, basePath, repackPath)) ? undefined : "signer-changed";
}

/**
 * The repack of the current worktree's JS over the simulator base, no device involved: reuse the cached one, or ensure
 * the base (`ensureKindBuild`), bundle, Hermes-compile, let the platform's `ApplyRepack` write the artifact, and
 * record it. One bundle per `(project, platform, jsKey)` at a time: a concurrent run waits on the build lock and finds
 * the holder's repack. The artifact is staged beside its final dir and moved in, so a failure leaves neither a
 * half-written dir nor a record. Install the result with `ensureApp` at `hash`.
 */
export async function repackApp(input: RepackInput): AsyncResult<RepackResult> {
	const { store, exec, platform, project, projectKey } = input;
	const entry = resolveEntryFile(project.root);
	if (!entry) return err(`repack: no entry file in ${project.root} (package.json "main" or index.js/ts)`);
	const flags = bundlerFlags(platform, project.framework, relative(project.root, entry));
	const keys = await computeKindKey({
		exec,
		project,
		platform,
		kind: "simulator",
		env: input.env,
		bundlerFlags: flags,
	});
	if (!keys.success) return keys;
	const repack = keys.data.repack;
	if (!repack) return err("repack: no repack key for the simulator kind");
	const hash = kindHash(repack);
	const baseHash = kindHash(keys.data.key);
	const query = { projectKey, platform, nativeFp: repack.nativeFp, jsKey: repack.jsKey };
	const startedAt = input.now();

	let reason: RepackReason | undefined;
	const reuse = async (): Promise<RepackResult | undefined> => {
		adoptKindDir(store, {
			env: input.env,
			projectKey,
			platform,
			profile: `${project.eas?.profile ?? LOCAL_PROFILE}:simulator`,
			key: repack,
			now: input.now(),
		});
		const hit = findRepack(store, query);
		if (!hit || (input.force && hit.createdAt < startedAt)) return undefined;
		const meta = await readRepackMeta(dirname(hit.path));
		const base = findSimulatorBase(store, { projectKey, platform, nativeFp: repack.nativeFp });
		const stale =
			base && existsSync(base.path) ? await staleReason(input, base.path, hit.path, meta?.baseId) : undefined;
		if (stale) {
			reason = stale;
			return undefined;
		}
		touchBuild(store, projectKey, platform, hit.hash, input.now());
		return {
			kind: "reused",
			artifact: hit.path,
			hash,
			baseHash,
			jsKey: repack.jsKey,
			...(meta ? { bundleMs: meta.bundleMs } : {}),
		};
	};
	const early = await reuse();
	if (early) return ok(early);

	const baseKey = keys.data.key;
	const earlyBundle = baseWillBuild(input, baseKey, repack.nativeFp)
		? startEarlyBundle(input, flags, entry, keys.data)
		: undefined;
	try {
		const base = await (input.ensureBase ?? ensureKindBuild)({
			...input,
			key: baseKey,
			buildKey: keys.data.buildKey,
			native: keys.data.native,
		});
		if (!base.success) return base;
		const baseRecord = findSimulatorBase(store, { projectKey, platform, nativeFp: repack.nativeFp });
		const baseArtifact = baseRecord?.path ?? base.data.appPath;
		if (!baseArtifact || !existsSync(baseArtifact))
			return err(`repack: the simulator base build is missing (${baseHash})`);
		touchBuild(store, projectKey, platform, baseHash, input.now());

		const made: Made = { keys: keys.data, repack, flags, entry, hash, baseHash, baseArtifact, reason };
		const fromBase = platform === "android" && base.data.source === "build";
		return await withBuildLock(lockDeps(input), buildLockKey(projectKey, platform, repack.jsKey), async () => {
			const again = await reuse();
			if (again) return ok(again);
			made.reason = reason;
			if (fromBase && (await embedsBundle(input.exec, baseArtifact))) return adoptBase(input, made);
			return makeRepack(input, made, earlyBundle);
		});
	} finally {
		if (earlyBundle) {
			await earlyBundle.done;
			rmSync(earlyBundle.scratch, { recursive: true, force: true });
		}
	}
}

/**
 * Is an iOS simulator base about to be built (none cached, builds on)? Then the bundle can overlap it. Android builds
 * its base with the bundle embedded (adopted as the repack), so it is never raced. Registers a base a CI cache
 * restored without its row first, as `ensureApp` would.
 */
function baseWillBuild(input: RepackInput, baseKey: KindKeys["key"], nativeFp: string): boolean {
	const { store, platform, projectKey } = input;
	if (platform !== "ios" || !input.build) return false;
	adoptKindDir(store, {
		env: input.env,
		projectKey,
		platform,
		profile: `${input.project.eas?.profile ?? LOCAL_PROFILE}:simulator`,
		key: baseKey,
		now: input.now(),
	});
	const cached = findSimulatorBase(store, { projectKey, platform, nativeFp });
	return !(cached && existsSync(cached.path));
}

/** The repack's build lock deps (one bundle per `(project, platform, jsKey)` at a time). */
function lockDeps(input: RepackInput): BuildLockDeps {
	return {
		store: input.store,
		owner: input.owner,
		pid: input.pid,
		now: input.now,
		pidAlive: input.pidAlive,
		sleep: input.sleep,
		log: input.log,
		...(input.lockPollMs !== undefined ? { pollMs: input.lockPollMs } : {}),
	};
}

/** Start the bundler in its own scratch dir, now; never rejects (`done` carries the result). */
function startEarlyBundle(input: RepackInput, flags: readonly string[], entry: string, keys: KindKeys): EarlyBundle {
	const scratchRoot = input.scratchRoot ?? tmpdir();
	mkdirSync(scratchRoot, { recursive: true });
	const scratch = mkdtempSync(join(scratchRoot, "warden-repack-"));
	const startedAt = input.now();
	input.log(`bundling ${input.platform} JS while the simulator base builds`);
	const done = runBundler({
		exec: input.exec,
		root: input.project.root,
		platform: input.platform,
		framework: input.project.framework,
		flags,
		entry,
		env: { ...input.env, ...keys.settings.env },
		scratch,
		log: () => {},
	})
		.catch(
			(error: unknown): Result<RawBundle, string> =>
				err(`repack: ${error instanceof Error ? error.message : String(error)}`)
		)
		.then((raw) => ({ raw, endedAt: input.now() }));
	return { scratch, startedAt, done };
}

/** Does the apk carry `assets/index.android.bundle` (the RN Gradle plugin's bundle of a Release build)? */
async function embedsBundle(exec: Exec, apk: string): Promise<boolean> {
	const listing = await exec(["unzip", "-Z1", apk]);
	return listing.exitCode === 0 && listing.stdout.split("\n").includes("assets/index.android.bundle");
}

/**
 * The Android base this run just built (`assembleRelease` bundles the worktree's JS into it, with the kind's env) is
 * already the repack of that JS: its apk is copied into the repack dir and recorded, with no second bundle, apply or
 * re-sign. Only a base built here: one another warden built (or a cached one) may hold another checkout's JS.
 */
async function adoptBase(input: RepackInput, made: Made): AsyncResult<RepackResult> {
	const { platform, projectKey, env } = input;
	const { repack, hash, baseHash, baseArtifact } = made;
	const finalDir = repackDir(env, projectKey, platform, repack.nativeFp, repack.jsKey);
	let staging: string | undefined;
	try {
		mkdirSync(dirname(finalDir), { recursive: true });
		staging = mkdtempSync(join(dirname(finalDir), ".staging-"));
		const git = await gitContext(input.exec, input.project.root, input.git);
		if (!git.success) return git;
		const baseId = await baseIdentity(platform, baseArtifact);
		const name = basename(baseArtifact);
		copyFileSync(baseArtifact, join(staging, name), constants.COPYFILE_FICLONE);
		const artifact = commitRepack(input, made, { staging, finalDir, name, git: git.data, bundleMs: 0, baseId });
		input.log("using the JS bundle the fresh Android base build embeds as the repack (no second bundle)");
		return ok({
			kind: "repacked",
			artifact,
			hash,
			baseHash,
			jsKey: repack.jsKey,
			fromBase: true,
			...(made.reason ? { reason: made.reason } : {}),
		});
	} catch (error) {
		return err(`repack: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		if (staging) rmSync(staging, { recursive: true, force: true });
	}
}

type Made = {
	keys: KindKeys;
	repack: { nativeFp: string; jsKey: string };
	flags: readonly string[];
	entry: string;
	hash: string;
	baseHash: string;
	baseArtifact: string;
	reason: RepackReason | undefined;
};

/** The `simulator-repack` row of a repack that is in its final dir. */
function recordMade(input: RepackInput, made: Made, git: GitContext, artifact: string): void {
	const now = input.now();
	recordRepack(input.store, {
		kind: "simulator-repack",
		projectKey: input.projectKey,
		platform: input.platform,
		profile: `${input.project.eas?.profile ?? LOCAL_PROFILE}:simulator`,
		hash: made.hash,
		path: artifact,
		source: "build",
		size: diskSize(artifact),
		createdAt: now,
		lastUsedAt: now,
		baseHash: made.baseHash,
		jsKey: made.repack.jsKey,
		worktree: git.worktree,
		...(git.branch ? { branch: git.branch } : {}),
	});
}

type Staged = {
	staging: string;
	finalDir: string;
	/** the artifact's file / dir name inside `staging` */
	name: string;
	git: GitContext;
	bundleMs: number;
	baseId: string | undefined;
};

/**
 * Write `meta.json` beside the staged artifact, swap `staging` in as `finalDir` and record the repack; returns the
 * artifact's final path. Devices that ran the repack this one replaces must install the new one, so their install
 * records of it are forgotten.
 */
function commitRepack(input: RepackInput, made: Made, staged: Staged): string {
	const { staging, finalDir, git, baseId } = staged;
	writeRepackMeta(staging, {
		worktree: git.worktree,
		...(git.branch ? { branch: git.branch } : {}),
		head: git.head,
		createdAt: input.now(),
		bundleMs: staged.bundleMs,
		...(baseId !== undefined ? { baseId } : {}),
	});
	if (existsSync(finalDir)) forgetInstallsAt(input.store, input.platform, [made.hash]);
	rmSync(finalDir, { recursive: true, force: true });
	renameSync(staging, finalDir);
	const artifact = join(finalDir, staged.name);
	recordMade(input, made, git, artifact);
	return artifact;
}

/**
 * The repacker's bundle, timed: the `early` bundle's run plus its Hermes compile, or a bundle run now. `bundleMs` is
 * bundler + Hermes time either way, not the wait for the base.
 */
async function bundleFor(
	step: BundleStep,
	early: EarlyBundle | undefined,
	now: () => number
): AsyncResult<{ bundled: BundleOutput; bundleMs: number }> {
	let started = now();
	let raw: Result<RawBundle, string>;
	let earlyMs = 0;
	if (early) {
		const result = await early.done;
		raw = result.raw;
		earlyMs = Math.max(0, result.endedAt - early.startedAt);
		started = now();
	} else raw = await runBundler(step);
	if (!raw.success) return raw;
	const bundled = await finishBundle(step, raw.data);
	if (!bundled.success) return bundled;
	return ok({ bundled: bundled.data, bundleMs: earlyMs + Math.max(0, now() - started) });
}

/**
 * Bundle (or take the `early` bundle made while the base built), apply, stage, move into `repackDir`, write
 * `meta.json`, record. Scratch and staging dirs always go (the `early` scratch is the caller's).
 */
async function makeRepack(input: RepackInput, made: Made, early?: EarlyBundle): AsyncResult<RepackResult> {
	const { exec, platform, project, projectKey, env } = input;
	const { repack, hash, baseHash, baseArtifact } = made;
	const finalDir = repackDir(env, projectKey, platform, repack.nativeFp, repack.jsKey);
	const scratchRoot = input.scratchRoot ?? tmpdir();
	let scratch: string | undefined;
	let staging: string | undefined;
	try {
		mkdirSync(dirname(finalDir), { recursive: true });
		mkdirSync(scratchRoot, { recursive: true });
		scratch = early?.scratch ?? mkdtempSync(join(scratchRoot, "warden-repack-"));
		staging = mkdtempSync(join(dirname(finalDir), ".staging-"));
		const baseId = await baseIdentity(platform, baseArtifact);
		const git = await gitContext(exec, project.root, input.git);
		if (!git.success) return git;
		const hermes = await (input.hermes ?? detectHermes)(exec, platform, baseArtifact);
		input.onPhase?.({ phase: "repacking", platform, jsKey: repack.jsKey });
		const step: BundleStep = {
			exec,
			root: project.root,
			platform,
			framework: project.framework,
			flags: made.flags,
			entry: made.entry,
			env: { ...input.env, ...made.keys.settings.env },
			scratch,
			hermes,
			log: input.log,
			...(input.buildOutput ? { output: input.buildOutput } : {}),
		};
		const timed = await bundleFor(step, early, input.now);
		if (!timed.success) return timed;
		const { bundled, bundleMs } = timed.data;

		const applied = await input.repackers[platform]({ exec, baseArtifact, outDir: staging, bundle: bundled });
		if (!applied.success) return err(`repack: ${applied.error}`);
		if ("fallback" in applied.data) return ok({ kind: "fallback", reason: applied.data.reason });

		const stagedArtifact = applied.data.artifact;
		if (!existsSync(stagedArtifact)) return err(`repack: the repacker wrote no artifact (${stagedArtifact})`);
		const artifact = commitRepack(input, made, {
			staging,
			finalDir,
			name: basename(stagedArtifact),
			git: git.data,
			bundleMs,
			baseId,
		});
		return ok({
			kind: "repacked",
			artifact,
			hash,
			baseHash,
			jsKey: repack.jsKey,
			bundleMs,
			...(made.reason ? { reason: made.reason } : {}),
		});
	} catch (error) {
		return err(`repack: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		if (scratch) rmSync(scratch, { recursive: true, force: true });
		if (staging) rmSync(staging, { recursive: true, force: true });
	}
}
