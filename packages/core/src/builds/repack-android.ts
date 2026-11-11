import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import type { Exec, ExecResult } from "../exec";
import type { ApplyRepack, ApplyRepackInput, ApplyRepackOutput, RepackFallback } from "./repack.types";
import { readCachedSigning } from "./signing-key";

/** The APK entry RN's gradle plugin writes the bundle to (`bundleAssetName`'s default). */
const BUNDLE_ENTRY = "assets/index.android.bundle";
/** How many missing asset paths a fallback reason names. */
const MAX_NAMED_PATHS = 5;
/** Old v1 signature entries: `apksigner` writes new ones, stale ones would not match the new contents. */
const V1_SIGNATURE = /^META-INF\/[^/]+\.(SF|RSA|DSA|EC|MF)$/;

export type AndroidKeystore = { path: string; alias: string; storePass: string; keyPass: string };

export type AndroidRepackerOptions = {
	/**
	 * tried after the keystore cached beside the base APK (the one Gradle signed the base with, saved when warden built
	 * it) and before the default `~/.android/debug.keystore` (`androiddebugkey` / `android`). The first whose
	 * certificate equals the base's signer signs the repack.
	 */
	keystore?: AndroidKeystore | undefined;
	/** Android SDK root; default `ANDROID_HOME`, `ANDROID_SDK_ROOT`, then `~/Library/Android/sdk` */
	sdkRoot?: string | undefined;
	env?: Record<string, string | undefined>;
	home?: string;
};

type Tools = { zipalign: string; apksigner: string; aapt2: string | undefined };

/** `35.0.0` > `34.0.0`; a release candidate (`36.0.0-rc1`) sorts below any plain version. */
function compareBuildTools(a: string, b: string): number {
	const rc = (v: string) => (v.includes("-") ? 0 : 1);
	if (rc(a) !== rc(b)) return rc(a) - rc(b);
	const parts = (v: string) => v.split("-")[0]?.split(".").map(Number) ?? [];
	const [pa, pb] = [parts(a), parts(b)];
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function findTools(options: AndroidRepackerOptions): { tools: Tools } | { error: string } {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const candidates = [
		options.sdkRoot,
		env.ANDROID_HOME,
		env.ANDROID_SDK_ROOT,
		join(home, "Library", "Android", "sdk"),
	].filter((root): root is string => root !== undefined && root !== "");
	for (const root of candidates) {
		const toolsDir = join(root, "build-tools");
		if (!existsSync(toolsDir)) continue;
		const versions = readdirSync(toolsDir)
			.filter((v) => existsSync(join(toolsDir, v, "zipalign")) && existsSync(join(toolsDir, v, "apksigner")))
			.sort(compareBuildTools);
		const newest = versions.at(-1);
		if (newest === undefined) continue;
		const aapt2 = join(toolsDir, newest, "aapt2");
		return {
			tools: {
				zipalign: join(toolsDir, newest, "zipalign"),
				apksigner: join(toolsDir, newest, "apksigner"),
				aapt2: existsSync(aapt2) ? aapt2 : undefined,
			},
		};
	}
	return {
		error: `Android build-tools (zipalign, apksigner) not found under ${candidates.map((c) => join(c, "build-tools")).join(", ")}: install them with sdkmanager or set ANDROID_HOME`,
	};
}

function resolveKeystores(
	options: AndroidRepackerOptions,
	baseArtifact: string
): { keystores: AndroidKeystore[] } | { error: string } {
	const path = join(options.home ?? homedir(), ".android", "debug.keystore");
	const cached = readCachedSigning(dirname(baseArtifact));
	const keystores: AndroidKeystore[] = [...(cached ? [cached] : []), ...(options.keystore ? [options.keystore] : [])];
	if (existsSync(path)) keystores.push({ path, alias: "androiddebugkey", storePass: "android", keyPass: "android" });
	if (keystores.length === 0) {
		return { error: `no signing keystore: ${path} is missing (run any Android debug build once, or pass a keystore)` };
	}
	return { keystores };
}

const SIGNER_SHA = /certificate SHA-256 digest: ([0-9a-f]+)/i;

/** The first signer's SHA-256 certificate fingerprint of `apk`; undefined when `apksigner` cannot print one. */
async function signerFingerprint(exec: Exec, apksigner: string, apk: string): Promise<string | undefined> {
	const res = await exec([apksigner, "verify", "--print-certs", apk]);
	if (res.exitCode !== 0) return undefined;
	return SIGNER_SHA.exec(res.stdout)?.[1]?.toLowerCase();
}

/**
 * Does `repack` carry the same certificate as `base`? A cached repack signed with another key cannot update the base's
 * install. True when either cannot be read (nothing to compare), so a missing SDK never blocks a reuse.
 */
export async function androidKeepsSigner(
	exec: Exec,
	base: string,
	repack: string,
	options: AndroidRepackerOptions = {}
): Promise<boolean> {
	const found = findTools(options);
	if ("error" in found) return true;
	const [a, b] = await Promise.all([
		signerFingerprint(exec, found.tools.apksigner, base),
		signerFingerprint(exec, found.tools.apksigner, repack),
	]);
	return a === undefined || b === undefined || a === b;
}

/** Run a tool; a non-zero exit is an error naming the tool and its stderr (or stdout). */
async function run(exec: Exec, cmd: readonly string[], cwd?: string): AsyncResult<ExecResult> {
	const res = await exec(cmd, cwd === undefined ? undefined : { cwd });
	if (res.exitCode === 0) return ok(res);
	const detail = (res.stderr.trim() || res.stdout.trim()).split("\n").slice(-6).join("\n");
	return err(`${basename(cmd[0] ?? "")} failed (exit ${res.exitCode}): ${detail}`);
}

async function listEntries(exec: Exec, apk: string): AsyncResult<string[]> {
	const res = await run(exec, ["unzip", "-Z1", apk]);
	if (!res.success) return res;
	return ok(res.data.stdout.split("\n").filter((line) => line !== ""));
}

/** Every file under `root`, as posix-style paths relative to it. */
function walk(root: string): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	const visit = (current: string) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) visit(full);
			else files.push(relative(root, full).split(sep).join("/"));
		}
	};
	visit(root);
	return files.sort();
}

/** One compiled resource file of the base: where it lives in the APK (release builds shorten it to `res/Ab.png`). */
type ResFile = { entry: string; compiledXml: boolean };

const normalizeConfig = (config: string) => config.replace(/(^|-)v\d+$/, "").replace(/^default$/, "");

/**
 * `aapt2 dump resources` -> `<type>/<name>/<config>` to its file. The APK's own paths can't be matched by name: release
 * builds shorten them (`res/-B.png`), the table is the only place that still says which file is which resource.
 */
export function parseResourceFiles(dump: string): Map<string, ResFile> {
	const files = new Map<string, ResFile>();
	let resource: string | undefined;
	for (const line of dump.split("\n")) {
		const header = /^\s+resource 0x[0-9a-f]+ ([^/\s]+)\/(\S+)$/.exec(line);
		if (header) {
			resource = `${header[1]}/${header[2]}`;
			continue;
		}
		const file = /^\s+\(([^)]*)\) \(file\) (\S+)(?: type=(\w+))?/.exec(line);
		if (file && resource !== undefined) {
			files.set(`${resource}/${normalizeConfig(file[1] ?? "")}`, {
				entry: file[2] ?? "",
				compiledXml: file[3] === "XML",
			});
		}
	}
	return files;
}

/** `drawable-mdpi/foo.png` -> `drawable/foo/mdpi`; `raw/foo.ttf` -> `raw/foo/`. */
function resourceKey(rel: string): string | undefined {
	const match = /^([^/-]+)(?:-([^/]+))?\/([^/]+)$/.exec(rel);
	if (!match) return undefined;
	const file = match[3] ?? "";
	const dot = file.lastIndexOf(".");
	return `${match[1]}/${dot > 0 ? file.slice(0, dot) : file}/${normalizeConfig(match[2] ?? "")}`;
}

const isResAsset = (rel: string) => /^(drawable|raw)[^/]*\//.test(rel);

type Plan = { fallback: string[] } | { res: Map<string, string>; assets: string[] };

/**
 * Where each bundler asset goes. `drawable-*` / `raw` are compiled resources (`resources.arsc` points at their files),
 * so only a resource the base already has can take new bytes; one it lacks needs aapt2 relinking and is reported.
 * Compiled XML (vector drawables) cannot take the bundler's source XML and keeps the base's. Anything else goes
 * under `assets/`.
 */
function planAssets(assetFiles: string[], resources: Map<string, ResFile>): Plan {
	const missing: string[] = [];
	const res = new Map<string, string>();
	const assets: string[] = [];
	for (const rel of assetFiles) {
		if (!isResAsset(rel)) {
			assets.push(rel);
			continue;
		}
		const key = resourceKey(rel);
		const file = key === undefined ? undefined : resources.get(key);
		if (file === undefined) missing.push(rel);
		else if (!file.compiledXml) res.set(rel, file.entry);
	}
	return missing.length > 0 ? { fallback: missing } : { res, assets };
}

function fallbackReason(missing: string[]): string {
	const named = missing.slice(0, MAX_NAMED_PATHS).join(", ");
	const more = missing.length > MAX_NAMED_PATHS ? `, +${missing.length - MAX_NAMED_PATHS} more` : "";
	return `new Android resource(s): ${named}${more} (${missing.length} in all) - needs a full build, since they are compiled into resources.arsc`;
}

async function packageName(exec: Exec, aapt2: string, apk: string): AsyncResult<string | undefined> {
	const res = await run(exec, [aapt2, "dump", "badging", apk]);
	if (!res.success) return res;
	return ok(/package: name='([^']+)'/.exec(res.data.stdout)?.[1]);
}

function stageFile(from: string, stageDir: string, entry: string): void {
	const to = join(stageDir, entry);
	mkdirSync(dirname(to), { recursive: true });
	copyFileSync(from, to);
}

type Swap = {
	tools: Tools;
	/** candidates in order; the first matching `baseSigner` signs */
	keystores: AndroidKeystore[];
	/** the base's signer certificate fingerprint; undefined when unreadable (the first keystore then signs unchecked) */
	baseSigner: string | undefined;
	baseEntries: string[];
	plan: { res: Map<string, string>; assets: string[] };
};

/** Zip the staged bundle and assets into `apk` (replacing same-named entries) after dropping the old v1 signature. */
async function swapEntries(input: ApplyRepackInput, swap: Swap, work: string, apk: string): AsyncResult<void> {
	const { exec, baseArtifact, bundle } = input;
	const bundleStage = join(work, "bundle");
	const assetStage = join(work, "assets");
	stageFile(bundle.bundle, bundleStage, BUNDLE_ENTRY);
	for (const [rel, entry] of swap.plan.res) stageFile(join(bundle.assetsDir, rel), assetStage, entry);
	for (const rel of swap.plan.assets) stageFile(join(bundle.assetsDir, rel), assetStage, `assets/${rel}`);
	copyFileSync(baseArtifact, apk);

	const stale = swap.baseEntries.filter((entry) => V1_SIGNATURE.test(entry));
	if (stale.length > 0) {
		const deleted = await run(exec, ["zip", "-q", "-d", apk, ...stale]);
		if (!deleted.success) return deleted;
	}
	const bundled = await run(exec, ["zip", "-q", "-X", "-D", "-0", apk, BUNDLE_ENTRY], bundleStage);
	if (!bundled.success) return bundled;
	const roots = existsSync(assetStage) ? readdirSync(assetStage) : [];
	if (roots.length === 0) return ok(undefined);
	const added = await run(exec, ["zip", "-q", "-X", "-D", "-r", apk, ...roots], assetStage);
	return added.success ? ok(undefined) : added;
}

/** Why no keystore could keep the base's signer: a differently-signed copy cannot be updated in place on a device. */
function signerMismatch(swap: Swap, tried: string[]): RepackFallback {
	const names = tried.map((sha, i) => `${swap.keystores[i]?.path} (${sha.slice(0, 8)})`).join(", ");
	return {
		fallback: true,
		reason: `no available keystore matches the base's signer ${swap.baseSigner?.slice(0, 8)} (tried ${names}): a repack signed with another key could not replace the base on a device, so a full build is needed`,
	};
}

/** Sign the aligned apk with one keystore (v2/v3) to `signed`. */
function signWith(exec: Exec, apksigner: string, ks: AndroidKeystore, aligned: string, signed: string) {
	return run(exec, [
		apksigner,
		"sign",
		"--ks",
		ks.path,
		"--ks-key-alias",
		ks.alias,
		"--ks-pass",
		`pass:${ks.storePass}`,
		"--key-pass",
		`pass:${ks.keyPass}`,
		"--out",
		signed,
		aligned,
	]);
}

/**
 * zipalign `apk`, sign it to `signed` with the first keystore whose certificate is the base's signer, and verify.
 * A repack signed with any other key cannot update the base's install, so no match is a fallback, never a guess.
 */
async function alignAndSign(
	exec: Exec,
	swap: Swap,
	work: string,
	apk: string,
	signed: string
): AsyncResult<RepackFallback | undefined> {
	const { tools, keystores, baseSigner } = swap;
	const aligned = join(work, "aligned.apk");
	const align = await run(exec, [tools.zipalign, "-p", "-f", "4", apk, aligned]);
	if (!align.success) return align;
	const tried: string[] = [];
	for (const ks of keystores) {
		const sign = await signWith(exec, tools.apksigner, ks, aligned, signed);
		if (!sign.success) return sign;
		const sha = baseSigner === undefined ? undefined : await signerFingerprint(exec, tools.apksigner, signed);
		if (baseSigner !== undefined && sha !== baseSigner) {
			tried.push(sha ?? "unknown");
			rmSync(signed, { force: true });
			continue;
		}
		const verify = await run(exec, [tools.apksigner, "verify", signed]);
		return verify.success ? ok(undefined) : verify;
	}
	return ok(signerMismatch(swap, tried));
}

/** The signed APK holds the bundle and still has the base's package name (checked when `aapt2` is available). */
async function validate(exec: Exec, tools: Tools, baseArtifact: string, signed: string): AsyncResult<void> {
	const entries = await listEntries(exec, signed);
	if (!entries.success) return entries;
	if (!entries.data.includes(BUNDLE_ENTRY)) return err(`repacked APK has no ${BUNDLE_ENTRY} entry`);
	if (tools.aapt2 === undefined) return ok(undefined);
	const before = await packageName(exec, tools.aapt2, baseArtifact);
	if (!before.success) return before;
	const after = await packageName(exec, tools.aapt2, signed);
	if (!after.success) return after;
	if (before.data !== after.data) return err(`repack changed the package name (${before.data} -> ${after.data})`);
	return ok(undefined);
}

type Prepared = { swap: Swap } | { fallback: RepackFallback } | { error: string };

/** Resolve tools and keystore, list the base and plan the assets: everything that can say no before any file is written. */
async function prepare(options: AndroidRepackerOptions, input: ApplyRepackInput): Promise<Prepared> {
	const found = findTools(options);
	if ("error" in found) return found;
	const signing = resolveKeystores(options, input.baseArtifact);
	if ("error" in signing) return signing;
	const baseSigner = await signerFingerprint(input.exec, found.tools.apksigner, input.baseArtifact);
	const baseEntries = await listEntries(input.exec, input.baseArtifact);
	if (!baseEntries.success) return { error: baseEntries.error };
	const assetFiles = walk(input.bundle.assetsDir);
	let resources = new Map<string, ResFile>();
	if (assetFiles.some(isResAsset)) {
		if (found.tools.aapt2 === undefined)
			return { error: "aapt2 not found in the newest build-tools: it maps the base's resources to files" };
		const dump = await run(input.exec, [found.tools.aapt2, "dump", "resources", input.baseArtifact]);
		if (!dump.success) return { error: dump.error };
		resources = parseResourceFiles(dump.data.stdout);
	}
	const plan = planAssets(assetFiles, resources);
	if ("fallback" in plan) return { fallback: { fallback: true, reason: fallbackReason(plan.fallback) } };
	return {
		swap: { tools: found.tools, keystores: signing.keystores, baseSigner, baseEntries: baseEntries.data, plan },
	};
}

/**
 * Build `repack(apk)`: swap `assets/index.android.bundle` (and the bundler's assets) into a copy of the simulator base,
 * zipalign and re-sign it. Everything happens in a scratch dir inside `outDir`; the artifact appears only when signed
 * and verified, so a failure leaves nothing behind.
 */
export function androidRepacker(options: AndroidRepackerOptions = {}): ApplyRepack {
	return async (input: ApplyRepackInput): AsyncResult<ApplyRepackOutput | RepackFallback> => {
		const { exec, baseArtifact, outDir } = input;
		const prepared = await prepare(options, input);
		if ("error" in prepared) return err(prepared.error);
		if ("fallback" in prepared) return ok(prepared.fallback);
		const { swap } = prepared;

		mkdirSync(outDir, { recursive: true });
		const work = mkdtempSync(join(outDir, ".repack-android-"));
		try {
			const apk = join(work, "unsigned.apk");
			const signed = join(work, basename(baseArtifact));
			const swapped = await swapEntries(input, swap, work, apk);
			if (!swapped.success) return swapped;
			const sign = await alignAndSign(exec, swap, work, apk, signed);
			if (!sign.success) return sign;
			if (sign.data !== undefined) return ok(sign.data);
			const valid = await validate(exec, swap.tools, baseArtifact, signed);
			if (!valid.success) return valid;
			const artifact = join(outDir, basename(baseArtifact));
			renameSync(signed, artifact);
			return ok({ artifact });
		} catch (error) {
			return err(error);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	};
}

/** The default repacker: SDK, keystore and tools resolved from the environment. */
export const applyAndroidRepack: ApplyRepack = androidRepacker();
