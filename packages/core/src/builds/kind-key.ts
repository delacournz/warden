import { type AsyncResult, ok } from "@delacour/warden-types/result";
import type { Exec } from "../exec";
import type { Platform } from "../types";
import type { KindKey } from "./cache";
import type { Project } from "./config";
import type { KindBuildKey } from "./ensure";
import { computeCacheKey, type FingerprintMemo } from "./fingerprint";
import type { ReadFile } from "./js-inputs";
import { computeJsKey } from "./js-key";
import { type BuildKind, type KindSettings, projectForKind, resolveKind } from "./kinds";

export type KindKeyDeps = {
	exec: Exec;
	project: Project;
	platform: Platform;
	kind: BuildKind;
	/** the process env the bundle step will run in (`EXPO_PUBLIC_*`, `NODE_ENV`: part of the JS key) */
	env: Record<string, string | undefined>;
	readFile?: ReadFile;
	memo?: FingerprintMemo;
	/** the bundler's own flags, part of the JS key */
	bundlerFlags?: readonly string[];
};

export type KindKeys = {
	/** the build to ensure: `dev`, the `simulator-base`, or the `release` build */
	key: KindBuildKey;
	/** `simulator` only: the repack of the current JS over the base (`jsKey`'s content key) */
	repack?: Extract<KindKey, { kind: "simulator-repack" }>;
	/** what a local build is verified against after it ran (`ensureKindBuild`'s `buildKey`) */
	buildKey: string;
	/** the raw native fingerprint (the EAS lookup key) */
	native: string;
	/** the project resolved as `kind`, and the settings that did it */
	project: Project;
	settings: KindSettings;
};

/**
 * The cache keys of `kind` for `project` on `platform`. `nativeFp` is the cache key of the kind's native build with no JS
 * mixed in (Release-salted for `simulator` / `release`); `jsKey` (`simulator`: the repack, `release`: the build) is the
 * content key of `kinds.<kind>.jsInputs` + bundle env + native fingerprint (`computeJsKey`).
 */
export async function computeKindKey(deps: KindKeyDeps): AsyncResult<KindKeys> {
	const { exec, platform, kind } = deps;
	const settings = resolveKind(deps.project, kind);
	const project = projectForKind(deps.project, kind);
	const native = await computeCacheKey(exec, project, platform, deps.readFile, deps.memo, deps.env);
	if (!native.success) return native;
	const { jsInputs: _jsInputs, ...withoutJs } = project;
	const nativeOnly = settings.embedsJs
		? await computeCacheKey(exec, withoutJs, platform, deps.readFile, deps.memo, deps.env)
		: native;
	if (!nativeOnly.success) return nativeOnly;
	const nativeFp = nativeOnly.data.key;
	const base = { buildKey: native.data.key, native: native.data.native, project, settings };
	if (kind === "dev") return ok({ ...base, key: { kind: "dev", nativeFp } });
	const jsKey = await computeJsKey({
		exec,
		root: project.root,
		jsInputs: settings.jsInputs ?? [],
		kind: kind === "release" ? "release" : "simulator",
		platform,
		nativeFp,
		env: deps.env,
		kindEnv: settings.env,
		...(deps.readFile ? { readFile: deps.readFile } : {}),
		...(deps.bundlerFlags ? { bundlerFlags: deps.bundlerFlags } : {}),
	});
	if (!jsKey.success) return jsKey;
	if (kind === "release") return ok({ ...base, key: { kind: "release", nativeFp, jsKey: jsKey.data } });
	return ok({
		...base,
		key: { kind: "simulator-base", nativeFp },
		repack: { kind: "simulator-repack", nativeFp, jsKey: jsKey.data },
	});
}
