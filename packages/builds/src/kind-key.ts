import type { BuildKind } from "@delacour/warden-config/build-kinds";
import type { Exec } from "@delacour/warden-runtime/exec";
import type { Platform } from "@delacour/warden-store/types";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
import type { KindKey } from "./cache";
import type { Project } from "./config";
import type { KindBuildKey } from "./ensure";
import { type CacheKey, type FingerprintMemo, fingerprint } from "./fingerprint";
import type { ReadFile } from "./js-inputs";
import { jsKey } from "./js-key";
import { type DeviceTarget, type KindSettings, kinds } from "./kinds";

/** Why the `simulator` kind never runs on a physical device: its repack swaps JS into a build made for the simulator. */
export const SIMULATOR_ON_DEVICE =
	"the simulator kind is not supported on a physical iPhone (a repack cannot be re-signed for a device yet): use --kind release (or dev)";

export type KindKeyDeps = {
	exec: Exec;
	project: Project;
	platform: Platform;
	kind: BuildKind;
	/** build for a physical iPhone signed by this team (`dev` / `release` only): salted into every key */
	device?: DeviceTarget;
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

/** The pieces every kind's result shares. */
type KindBase = Pick<KindKeys, "buildKey" | "native" | "project" | "settings">;

/**
 * Computes the cache keys of a build kind. Deps arrive per call, so callers share the `kindKeyResolver` instance
 * (named so, not `KindKey`, because that is the key union exported by `cache.ts`).
 */
export class KindKeyResolver {
	/**
	 * The cache keys of `kind` for `project` on `platform`. `nativeFp` is the cache key of the kind's native build with no JS
	 * mixed in (Release-salted for `simulator` / `release`); `jsKey` (`simulator`: the repack, `release`: the build) is the
	 * content key of `kinds.<kind>.jsInputs` + bundle env + native fingerprint (`jsKey.compute`).
	 */
	async compute(deps: KindKeyDeps): AsyncResult<KindKeys> {
		const { platform, kind, device } = deps;
		if (device && kind === "simulator") return resultFactory.err(SIMULATOR_ON_DEVICE);
		const settings = kinds.resolve(deps.project, kind, device);
		const project = kinds.projectFor(deps.project, kind, device);
		const native = await this.cacheKey(deps, project, platform);
		if (!native.success) return native;
		const nativeOnly = await this.nativeOnly(deps, project, settings, native.data);
		if (!nativeOnly.success) return nativeOnly;
		const nativeFp = nativeOnly.data.key;
		const base: KindBase = { buildKey: native.data.key, native: native.data.native, project, settings };
		const onDevice = device ? { device } : {};
		if (kind === "dev") return resultFactory.ok({ ...base, key: { kind: "dev", nativeFp, ...onDevice } });
		const js = await this.jsKeyOf(deps, project, settings, nativeFp);
		if (!js.success) return js;
		if (kind === "release")
			return resultFactory.ok({ ...base, key: { kind: "release", nativeFp, jsKey: js.data, ...onDevice } });
		return resultFactory.ok({
			...base,
			key: { kind: "simulator-base", nativeFp },
			repack: { kind: "simulator-repack", nativeFp, jsKey: js.data },
		});
	}

	private cacheKey(deps: KindKeyDeps, project: Project, platform: Platform): AsyncResult<CacheKey> {
		return fingerprint.computeCacheKey(deps.exec, project, platform, deps.readFile, deps.memo, deps.env);
	}

	/** The native key with no JS mixed in: a kind that embeds JS needs a second key over the project without `jsInputs`. */
	private async nativeOnly(
		deps: KindKeyDeps,
		project: Project,
		settings: KindSettings,
		native: CacheKey
	): AsyncResult<CacheKey> {
		if (!settings.embedsJs) return resultFactory.ok(native);
		const { jsInputs: _jsInputs, ...withoutJs } = project;
		return this.cacheKey(deps, withoutJs, deps.platform);
	}

	private jsKeyOf(deps: KindKeyDeps, project: Project, settings: KindSettings, nativeFp: string): AsyncResult<string> {
		return jsKey.compute({
			exec: deps.exec,
			root: project.root,
			jsInputs: settings.jsInputs ?? [],
			kind: deps.kind === "release" ? "release" : "simulator",
			platform: deps.platform,
			nativeFp,
			env: deps.env,
			kindEnv: settings.env,
			...(deps.readFile ? { readFile: deps.readFile } : {}),
			...(deps.bundlerFlags ? { bundlerFlags: deps.bundlerFlags } : {}),
		});
	}
}

export const kindKeyResolver = new KindKeyResolver();
