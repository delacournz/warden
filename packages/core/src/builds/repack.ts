import {
	closeSync,
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
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import type { Exec } from "../exec";
import { findNodeBin } from "../node-bin";
import type { Platform } from "../types";
import { diskSize, findRepack, findSimulatorBase, kindHash, recordRepack, repackDir, touchBuild } from "./cache";
import { type EnsureKindInput, ensureKindBuild, LOCAL_PROFILE } from "./ensure";
import { type GitContext, gitContext, readRepackMeta, writeRepackMeta } from "./js-key";
import { computeKindKey, type KindKeys } from "./kind-key";
import { buildLockKey, withBuildLock } from "./lock";
import type { ApplyRepack, BundleOutput } from "./repack.types";

/** The first bytes of Hermes bytecode (`0x1f1903c103bc1fc6` little-endian). */
const HBC_MAGIC = Uint8Array.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]);

/** What `repackApp` produced: a cached repack (reused or just made), or why a full simulator build is needed instead. */
export type RepackResult =
	| {
			kind: "reused" | "repacked";
			/** the repacked `.app` / `.apk` */
			artifact: string;
			/** the cache / install hash of the repack (`kindHash`) */
			hash: string;
			/** the simulator base it was cloned from */
			baseHash: string;
			jsKey: string;
			/** bundle + Hermes compile time; absent when a reused repack has no readable `meta.json` */
			bundleMs?: number;
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

/** Bundle the JS into `scratch`, then Hermes-compile it when the base runs Hermes. */
async function bundleJs(step: BundleStep): AsyncResult<BundleOutput> {
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
	if (!step.hermes) return ok({ bundle, assetsDir, sourcemap: `${bundle}.map`, hermes: false });

	return compileHermes(step, bundle, assetsDir);
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

	const reuse = async (): Promise<RepackResult | undefined> => {
		const hit = findRepack(store, query);
		if (!hit || (input.force && hit.createdAt < startedAt)) return undefined;
		touchBuild(store, projectKey, platform, hit.hash, input.now());
		const meta = await readRepackMeta(dirname(hit.path));
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

	const base = await ensureKindBuild({
		...input,
		key: keys.data.key,
		buildKey: keys.data.buildKey,
		native: keys.data.native,
	});
	if (!base.success) return base;
	const baseRecord = findSimulatorBase(store, { projectKey, platform, nativeFp: repack.nativeFp });
	const baseArtifact = baseRecord?.path ?? base.data.appPath;
	if (!baseArtifact || !existsSync(baseArtifact))
		return err(`repack: the simulator base build is missing (${baseHash})`);
	touchBuild(store, projectKey, platform, baseHash, input.now());

	const lock = {
		store,
		owner: input.owner,
		pid: input.pid,
		now: input.now,
		pidAlive: input.pidAlive,
		sleep: input.sleep,
		log: input.log,
		...(input.lockPollMs !== undefined ? { pollMs: input.lockPollMs } : {}),
	};
	return withBuildLock(lock, buildLockKey(projectKey, platform, repack.jsKey), async () => {
		const again = await reuse();
		if (again) return ok(again);
		return makeRepack(input, { keys: keys.data, repack, flags, entry, hash, baseHash, baseArtifact });
	});
}

type Made = {
	keys: KindKeys;
	repack: { nativeFp: string; jsKey: string };
	flags: readonly string[];
	entry: string;
	hash: string;
	baseHash: string;
	baseArtifact: string;
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

/** Bundle, apply, stage, move into `repackDir`, write `meta.json`, record. Scratch and staging dirs always go. */
async function makeRepack(input: RepackInput, made: Made): AsyncResult<RepackResult> {
	const { exec, platform, project, projectKey, env } = input;
	const { repack, hash, baseHash, baseArtifact } = made;
	const finalDir = repackDir(env, projectKey, platform, repack.nativeFp, repack.jsKey);
	const scratchRoot = input.scratchRoot ?? tmpdir();
	let scratch: string | undefined;
	let staging: string | undefined;
	try {
		mkdirSync(dirname(finalDir), { recursive: true });
		mkdirSync(scratchRoot, { recursive: true });
		scratch = mkdtempSync(join(scratchRoot, "warden-repack-"));
		staging = mkdtempSync(join(dirname(finalDir), ".staging-"));
		const git = await gitContext(exec, project.root, input.git);
		if (!git.success) return git;
		const hermes = await (input.hermes ?? detectHermes)(exec, platform, baseArtifact);
		const started = input.now();
		input.onPhase?.({ phase: "repacking", platform, jsKey: repack.jsKey });
		const bundled = await bundleJs({
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
		});
		if (!bundled.success) return bundled;
		const bundleMs = Math.max(0, input.now() - started);

		const applied = await input.repackers[platform]({ exec, baseArtifact, outDir: staging, bundle: bundled.data });
		if (!applied.success) return err(`repack: ${applied.error}`);
		if ("fallback" in applied.data) return ok({ kind: "fallback", reason: applied.data.reason });

		const stagedArtifact = applied.data.artifact;
		if (!existsSync(stagedArtifact)) return err(`repack: the repacker wrote no artifact (${stagedArtifact})`);
		const artifact = join(finalDir, basename(stagedArtifact));
		writeRepackMeta(staging, {
			worktree: git.data.worktree,
			...(git.data.branch ? { branch: git.data.branch } : {}),
			head: git.data.head,
			createdAt: input.now(),
			bundleMs,
		});
		rmSync(finalDir, { recursive: true, force: true });
		renameSync(staging, finalDir);
		recordMade(input, made, git.data, artifact);
		return ok({ kind: "repacked", artifact, hash, baseHash, jsKey: repack.jsKey, bundleMs });
	} catch (error) {
		return err(`repack: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		if (scratch) rmSync(scratch, { recursive: true, force: true });
		if (staging) rmSync(staging, { recursive: true, force: true });
	}
}
