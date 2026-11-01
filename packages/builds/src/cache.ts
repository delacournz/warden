import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { cp } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { BuildKind } from "@delacour/warden-config/build-kinds";
import {
	type BuildBase,
	type BuildRecord,
	type BuildSource,
	BuildsTable,
	type SimulatorBaseRecord,
	type SimulatorRepackRecord,
} from "@delacour/warden-store/builds-table";
import type { Store } from "@delacour/warden-store/store";
import { storeLocator } from "@delacour/warden-store/store";
import type { Platform } from "@delacour/warden-store/types";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
import type { DeviceTarget } from "./kinds";
import { projectKeys } from "./project-key";

/** Where a build of a kind lives and what it is called; `kindHash` / `kindDir` derive both. */
export type KindKey =
	| { kind: "dev"; nativeFp: string; device?: DeviceTarget }
	| { kind: "simulator-base"; nativeFp: string }
	| { kind: "simulator-repack"; nativeFp: string; jsKey: string }
	| { kind: "release"; nativeFp: string; jsKey: string; device?: DeviceTarget };

type Env = Record<string, string | undefined>;

export type RepackQuery = { projectKey: string; platform: Platform; nativeFp: string; jsKey: string };

export type SimulatorBaseQuery = { projectKey: string; platform: Platform; nativeFp: string };

export type StoreArtifactInput = {
	store: Store;
	env: Record<string, string | undefined>;
	projectKey: string;
	platform: Platform;
	profile: string;
	hash: string;
	/** existing `.app` dir / `.apk` */
	artifact: string;
	source: BuildSource;
	/** move instead of copy (eas-cli's temp download); falls back to copy across filesystems */
	move?: boolean;
	/** a kind's dir + row fields instead of the flat `<platform>/<hash>/` (`hash` is then the kind's `kindHash`) */
	layout?: KindLayout;
	now: number;
};

/** Where `storeArtifact` puts an artifact of a kind, and what the row records. Repacks are written by the repack engine. */
export type KindLayout = { dir: string; kind: "dev" | "simulator-base" | { kind: "release"; jsKey: string } };

/** Names under a `<nativeFp>` dir that belong to the kinds, not to the legacy build sitting beside them. */
const KIND_DIR_NAMES: ReadonlySet<string> = new Set(["dev", "simulator", "release", "device"]);

/**
 * The on-disk build cache and its rows: where a build of a kind lives (`dir`, `kindDir`), the `hash` it is keyed by,
 * and the store / lookup / alias / remove operations. `store` and `env` are passed per call, so callers use the
 * `buildCache` singleton.
 */
export class BuildCache {
	/** The `BuildKind` a record belongs to (a `legacy` record belongs to none). */
	kindOf(record: BuildRecord): BuildKind | undefined {
		switch (record.kind) {
			case undefined:
			case "legacy":
				return undefined;
			case "dev":
				return "dev";
			case "simulator-base":
			case "simulator-repack":
				return "simulator";
			case "release":
				return "release";
		}
	}

	/** The `BuildKind` a key is a build of (a repack belongs to `simulator`). */
	kindOfKey(key: KindKey): BuildKind {
		return key.kind === "dev" || key.kind === "release" ? key.kind : "simulator";
	}

	/** `$WARDEN_HOME/builds`. */
	root(env: Record<string, string | undefined>): string {
		return join(storeLocator.wardenHome(env), "builds");
	}

	/** `$WARDEN_HOME/builds/<safe projectKey>/<platform>/<hash>`. */
	dir(env: Record<string, string | undefined>, key: string, platform: Platform, hash: string): string {
		return join(this.root(env), projectKeys.safe(key), platform, hash);
	}

	/** `<dir>/<nativeFp>`: what the kind dirs hang off (a legacy build of the same fingerprint sits directly in it). */
	nativeDir(env: Env, key: string, platform: Platform, nativeFp: string): string {
		return this.dir(env, key, platform, nativeFp);
	}

	/** `<nativeDir>/dev`. */
	devDir(env: Env, key: string, platform: Platform, nativeFp: string, device?: DeviceTarget): string {
		return join(this.targetDir(env, key, platform, nativeFp, device), "dev");
	}

	/** `<nativeDir>/simulator/base`: the Release build with no JS bundle that repacks are cloned from. */
	simulatorBaseDir(env: Env, key: string, platform: Platform, nativeFp: string): string {
		return join(this.nativeDir(env, key, platform, nativeFp), "simulator", "base");
	}

	/** `<nativeDir>/simulator/repacks/<jsKey>`: a clone of the base with the bundle of `jsKey` (+ `meta.json`). */
	repackDir(env: Env, key: string, platform: Platform, nativeFp: string, jsKey: string): string {
		return join(this.nativeDir(env, key, platform, nativeFp), "simulator", "repacks", jsKey);
	}

	/** `<nativeDir>/release/<jsKey>`. */
	releaseDir(
		env: Env,
		key: string,
		platform: Platform,
		nativeFp: string,
		jsKey: string,
		device?: DeviceTarget
	): string {
		return join(this.targetDir(env, key, platform, nativeFp, device), "release", jsKey);
	}

	/** The cache / install `hash` of a build of a kind (the `(project_key, platform, hash)` primary key). */
	kindHash(key: KindKey): string {
		switch (key.kind) {
			case "dev":
				return `${this.hashBase(key)}:dev`;
			case "simulator-base":
				return `${key.nativeFp}:base`;
			case "simulator-repack":
				return `${key.nativeFp}:${key.jsKey}`;
			case "release":
				return `${this.hashBase(key)}:release:${key.jsKey}`;
		}
	}

	/** The directory a build of a kind lives in (its artifact is `<dir>/<App>.app|.apk`). */
	kindDir(env: Env, projectKey: string, platform: Platform, key: KindKey): string {
		switch (key.kind) {
			case "dev":
				return this.devDir(env, projectKey, platform, key.nativeFp, key.device);
			case "simulator-base":
				return this.simulatorBaseDir(env, projectKey, platform, key.nativeFp);
			case "simulator-repack":
				return this.repackDir(env, projectKey, platform, key.nativeFp, key.jsKey);
			case "release":
				return this.releaseDir(env, projectKey, platform, key.nativeFp, key.jsKey, key.device);
		}
	}

	/** Artifact extension per platform. */
	artifactExt(platform: Platform): ".app" | ".apk" {
		return platform === "ios" ? ".app" : ".apk";
	}

	/** First `*.app` (iOS) / `*.apk` (Android) directly inside `dir`. */
	findArtifact(dir: string, platform: Platform): string | undefined {
		if (!existsSync(dir)) return undefined;
		const name = readdirSync(dir)
			.sort()
			.find((n) => n.endsWith(this.artifactExt(platform)));
		return name ? join(dir, name) : undefined;
	}

	/** Recursive on-disk size (symlinks counted as links, not followed). */
	diskSize(path: string): number {
		const stat = lstatSync(path, { throwIfNoEntry: false });
		if (!stat) return 0;
		if (!stat.isDirectory()) return stat.size;
		return readdirSync(path).reduce((sum, name) => sum + this.diskSize(join(path, name)), 0);
	}

	/** Register a repack (its files are already in `repackDir`): the row `findRepack` and the prune read. */
	recordRepack(store: Store, record: SimulatorRepackRecord): void {
		new BuildsTable(store).upsert(record);
	}

	/**
	 * The cached repack of `jsKey` over `nativeFp` whose files still exist, else undefined. Not touched: call
	 * `touchBuild` with the record's `hash` when it is used.
	 */
	findRepack(store: Store, query: RepackQuery): SimulatorRepackRecord | undefined {
		const found = this.findKind(store, query.projectKey, query.platform, {
			kind: "simulator-repack",
			nativeFp: query.nativeFp,
			jsKey: query.jsKey,
		});
		return found?.kind === "simulator-repack" ? found : undefined;
	}

	/** The cached simulator base (Release, no JS bundle) of `nativeFp` whose files still exist, else undefined. */
	findSimulatorBase(store: Store, query: SimulatorBaseQuery): SimulatorBaseRecord | undefined {
		const found = this.findKind(store, query.projectKey, query.platform, {
			kind: "simulator-base",
			nativeFp: query.nativeFp,
		});
		return found?.kind === "simulator-base" ? found : undefined;
	}

	/** Every repack cloned from the base with `baseHash`. */
	repacksOf(
		builds: readonly BuildRecord[],
		projectKey: string,
		platform: Platform,
		baseHash: string
	): SimulatorRepackRecord[] {
		return builds.filter(
			(b): b is SimulatorRepackRecord =>
				b.kind === "simulator-repack" &&
				b.projectKey === projectKey &&
				b.platform === platform &&
				b.baseHash === baseHash
		);
	}

	/**
	 * Cached build whose artifact still exists (touched: `lastUsedAt = now`). A record whose files
	 * vanished is dropped and reported as a miss.
	 */
	cached(store: Store, key: string, platform: Platform, hash: string, now: number): BuildRecord | undefined {
		const record = new BuildsTable(store).get(key, platform, hash);
		if (!record) return undefined;
		if (!existsSync(record.path)) {
			new BuildsTable(store).remove(key, platform, hash);
			return undefined;
		}
		new BuildsTable(store).touch(key, platform, hash, now);
		// an alias shares the path: keep its primary (the row that owns the files) as recent for the LRU prune
		new BuildsTable(store).touchByPath(record.path, now);
		return { ...record, lastUsedAt: now };
	}

	/**
	 * Register `record`'s artifact under a second key `hash` (a fresh checkout's post-prebuild key, 17-1):
	 * same path, no files of its own, size 0 so totals and the prune count the bytes once. An existing
	 * build of `hash` whose files are there is kept. Returns whether the alias was written.
	 */
	alias(store: Store, record: BuildRecord, hash: string, now: number): boolean {
		if (hash === record.hash) return false;
		const existing = new BuildsTable(store).get(record.projectKey, record.platform, hash);
		if (existing && existsSync(existing.path)) return false;
		new BuildsTable(store).upsert({ ...record, hash, size: 0, createdAt: now, lastUsedAt: now });
		return true;
	}

	/** Put `artifact` into the cache dir for (project, platform, hash) and register it. */
	async storeArtifact(input: StoreArtifactInput): AsyncResult<BuildRecord> {
		const ext = this.artifactExt(input.platform);
		if (!input.artifact.endsWith(ext) || !existsSync(input.artifact)) {
			return resultFactory.err(`not a ${input.platform} build (${ext}): ${input.artifact}`);
		}
		const dir = input.layout?.dir ?? this.dir(input.env, input.projectKey, input.platform, input.hash);
		const target = join(dir, basename(input.artifact));
		try {
			await this.placeArtifact(input, dir, target);
		} catch (error) {
			return resultFactory.err(`caching ${input.artifact}: ${error instanceof Error ? error.message : String(error)}`);
		}
		const base: BuildBase = {
			projectKey: input.projectKey,
			platform: input.platform,
			profile: input.profile,
			hash: input.hash,
			path: target,
			source: input.source,
			size: this.diskSize(target),
			createdAt: input.now,
			lastUsedAt: input.now,
		};
		const layout = input.layout?.kind;
		const record: BuildRecord =
			layout === undefined
				? base
				: layout === "dev" || layout === "simulator-base"
					? { ...base, kind: layout }
					: { ...base, kind: "release", jsKey: layout.jsKey };
		new BuildsTable(input.store).upsert(record);
		return resultFactory.ok(record);
	}

	/**
	 * Remove a cached build's files and record. A `simulator-base` takes its repacks with it; a legacy build leaves the
	 * kind dirs of its fingerprint alone.
	 */
	remove(store: Store, env: Record<string, string | undefined>, record: BuildRecord): void {
		const legacy = record.kind === undefined || record.kind === "legacy";
		const dir = legacy ? this.dir(env, record.projectKey, record.platform, record.hash) : dirname(record.path);
		if (legacy) this.removeLegacyFiles(dir);
		else rmSync(dir, { recursive: true, force: true });
		new BuildsTable(store).remove(record.projectKey, record.platform, record.hash);
		if (record.kind === "simulator-base") {
			const builds = new BuildsTable(store).list();
			for (const repack of this.repacksOf(builds, record.projectKey, record.platform, record.hash)) {
				this.remove(store, env, repack);
			}
			rmSync(join(dirname(dir), "repacks"), { recursive: true, force: true });
		}
		// aliases of the removed files (`alias`) go with them
		for (const alias of new BuildsTable(store).list()) {
			if (dirname(alias.path) === dir) new BuildsTable(store).remove(alias.projectKey, alias.platform, alias.hash);
		}
	}

	/** Artifact for `hash` in any legacy cache root (`<dir>/<hash>/*.app|*.apk`). */
	findLegacyArtifact(dirs: readonly string[], platform: Platform, hash: string): string | undefined {
		for (const dir of dirs) {
			const hit = this.findArtifact(join(dir, hash), platform);
			if (hit) return hit;
		}
		return undefined;
	}

	/** `<nativeDir>`, or `<nativeDir>/device/<salt>` for a build signed for a physical iPhone. */
	private targetDir(env: Env, key: string, platform: Platform, nativeFp: string, device?: DeviceTarget): string {
		const native = this.nativeDir(env, key, platform, nativeFp);
		return device ? join(native, "device", device.salt) : native;
	}

	/** `<nativeFp>:device-<salt>` for a device build, else the fingerprint alone (what a kind's hash starts with). */
	private hashBase(key: { nativeFp: string; device?: DeviceTarget }): string {
		return key.device ? `${key.nativeFp}:device-${key.device.salt}` : key.nativeFp;
	}

	/** A row whose kind is `kind` and whose files still exist; a row whose files vanished is dropped. */
	private findKind(store: Store, projectKey: string, platform: Platform, key: KindKey): BuildRecord | undefined {
		const record = new BuildsTable(store).get(projectKey, platform, this.kindHash(key));
		if (!record || record.kind !== key.kind) return undefined;
		if (!existsSync(record.path)) {
			new BuildsTable(store).remove(projectKey, platform, record.hash);
			return undefined;
		}
		return record;
	}

	/** Move (`input.move`, falling back to a copy) or copy `input.artifact` to `target`, replacing `dir`. */
	private async placeArtifact(input: StoreArtifactInput, dir: string, target: string): Promise<void> {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		let moved = false;
		if (input.move) {
			try {
				renameSync(input.artifact, target);
				moved = true;
			} catch {
				moved = false;
			}
		}
		if (!moved) await cp(input.artifact, target, { recursive: true, verbatimSymlinks: true });
		// SKIP_BUNDLING skips the bundle phase but Xcode keeps the product's earlier main.jsbundle: a base has no JS
		if (input.layout?.kind === "simulator-base" && input.platform === "ios") {
			rmSync(join(target, "main.jsbundle"), { force: true });
		}
	}

	/** A legacy build's files only: its `<nativeFp>` dir also holds the kind dirs, which are other rows. */
	private removeLegacyFiles(dir: string): void {
		if (!existsSync(dir)) return;
		for (const name of readdirSync(dir)) {
			if (!KIND_DIR_NAMES.has(name)) rmSync(join(dir, name), { recursive: true, force: true });
		}
		if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
	}
}

export const buildCache = new BuildCache();
