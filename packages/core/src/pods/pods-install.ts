import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { readFileOrUndefined } from "../builds/js-inputs";
import { type BuildLockDeps, withBuildLock } from "../builds/lock";
import { planPrebuiltRn } from "../builds/prebuilt-rn";
import { execError } from "../exec";
import {
	POD_INSTALL_TIMEOUT_MS,
	POD_MISSING_HINT,
	PODS_PREBUILD_ARGV,
	PODS_PROBE_TIMEOUT_MS,
	PODS_STAMP_FILE,
} from "./pods.defaults";
import type { Env, PodsDeps, PodsInstallOptions, PodsMode, PodsOutcome, PodsTarget } from "./pods.types";
import { computePodsKey, detectMode, resolveRoot } from "./pods-key";
import { restorePods } from "./pods-restore";
import { snapshotPods } from "./pods-snapshot";
import { getPodsEntry, podsEntryDir, podsLockKey, podsRoot, removePodsEntry, touchPodsEntry } from "./pods-store";

function lockDeps(deps: PodsDeps): BuildLockDeps {
	return {
		store: deps.store,
		owner: deps.owner,
		pid: deps.pid,
		now: deps.now,
		pidAlive: deps.pidAlive,
		sleep: deps.sleep,
		log: deps.log,
		waitLine: (holder) => `another warden (${holder}) is installing these pods — waiting`,
		...(deps.lockPollMs !== undefined ? { pollMs: deps.lockPollMs } : {}),
		...(deps.lockWaitMs !== undefined ? { waitMs: deps.lockWaitMs } : {}),
		...(deps.lockTtlMs !== undefined ? { ttlMs: deps.lockTtlMs } : {}),
	};
}

/**
 * CNG: generate `ios/`. `clean` wipes and regenerates it even when it exists: a miss is about to be stored under a key
 * computed from the inputs, so the `ios/` it snapshots must be what those inputs generate, never a stale or hand-edited one
 * (it is git-ignored output, so wiping is safe). Without `clean`, only a missing `ios/Podfile` triggers prebuild.
 */
async function prebuildIfNeeded(deps: PodsDeps, target: PodsTarget, env: Env, clean = false): AsyncResult<void> {
	if (target.mode !== "cng") return ok(undefined);
	if (!clean && existsSync(join(target.iosAbs, "Podfile"))) return ok(undefined);
	const argv = clean ? [...PODS_PREBUILD_ARGV, "--clean"] : PODS_PREBUILD_ARGV;
	deps.log(`ios/ is generated: running ${argv.slice(0, 5).join(" ")}${clean ? " --clean" : ""}`);
	const res = await deps.exec(argv, {
		cwd: target.projectRoot,
		env,
		onLine: deps.log,
		timeoutMs: POD_INSTALL_TIMEOUT_MS,
	});
	if (res.exitCode !== 0) return err(`expo prebuild failed: ${execError(argv, res)}`);
	return ok(undefined);
}

async function runPodInstall(
	deps: PodsDeps,
	target: PodsTarget,
	opts: PodsInstallOptions,
	env: Env
): AsyncResult<void> {
	const argv = ["pod", "install", `--project-directory=${target.iosDir}`, ...(opts.podArgs ?? [])];
	const res = await deps.exec(argv, {
		cwd: target.projectRoot,
		env: { LANG: deps.env.LANG ?? "en_US.UTF-8", ...env },
		onLine: deps.log,
		timeoutMs: POD_INSTALL_TIMEOUT_MS,
	});
	if (res.exitCode !== 0) return err(`pod install failed: ${execError(argv, res)}`);
	return ok(undefined);
}

function stampPath(target: PodsTarget): string {
	return join(target.iosAbs, "Pods", PODS_STAMP_FILE);
}

function writeStamp(target: PodsTarget, key: string): void {
	mkdirSync(join(target.iosAbs, "Pods"), { recursive: true });
	writeFileSync(stampPath(target), key);
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** Podfile.lock equals Pods/Manifest.lock (Xcode's own check) and the stamp is `key`: nothing to do. */
function upToDate(target: PodsTarget, key: string): boolean {
	const lock = readText(join(target.iosAbs, "Podfile.lock"));
	const manifest = readText(join(target.iosAbs, "Pods", "Manifest.lock"));
	return lock !== undefined && lock === manifest && readText(stampPath(target)) === key;
}

async function plainInstall(
	deps: PodsDeps,
	target: PodsTarget,
	opts: PodsInstallOptions,
	env: Env,
	reason: string,
	t0: number
): AsyncResult<PodsOutcome> {
	const prebuilt = await prebuildIfNeeded(deps, target, env);
	if (!prebuilt.success) return prebuilt;
	const installed = await runPodInstall(deps, target, opts, env);
	if (!installed.success) return installed;
	return ok({ kind: "uncached", reason, ms: deps.now() - t0 });
}

/**
 * `pod install` through the machine-wide cache. Same pods key anywhere on the machine: clone the stored install into this
 * checkout (root rewritten, checksums fixed), prebuild and pod install both skipped. Otherwise run them, then store the
 * result. A failure to store or to restore never fails the install: it falls back to what a plain `pod install` gives.
 */
export async function podsInstall(deps: PodsDeps, opts: PodsInstallOptions): AsyncResult<PodsOutcome> {
	const t0 = deps.now();
	let projectRoot: string;
	try {
		projectRoot = realpathSync(opts.projectRoot);
	} catch {
		return err(`no such project directory: ${opts.projectRoot}`);
	}
	const iosDir = opts.iosDir ?? "ios";
	const probe = await deps.exec(["pod", "--version"], { cwd: projectRoot, timeoutMs: PODS_PROBE_TIMEOUT_MS });
	if (probe.exitCode !== 0) return err(POD_MISSING_HINT);
	const podVersion = probe.stdout.trim();

	const root = (await resolveRoot(deps.exec, projectRoot)) ?? { real: projectRoot, raw: projectRoot };
	const mode: PodsMode = await detectMode(deps.exec, projectRoot, iosDir, opts.framework ?? "expo");
	const target: PodsTarget = {
		projectRoot,
		iosDir,
		iosAbs: join(projectRoot, iosDir),
		root,
		projectRel: relative(root.real, projectRoot) || ".",
		mode,
	};
	const plan = await planPrebuiltRn({
		platform: "ios",
		projectRoot,
		...(opts.prebuiltReactNative === false ? { optOut: true } : {}),
		env: deps.env,
		readFile: readFileOrUndefined,
	});
	const installEnv: Env = plan.env;

	if (opts.noCache) return plainInstall(deps, target, opts, installEnv, "--no-cache", t0);

	const keyStart = deps.now();
	const keyed = await computePodsKey(deps, {
		projectRoot,
		root,
		iosDir,
		mode,
		podVersion,
		planEnv: plan.env,
		...(plan.salt !== undefined ? { planSalt: plan.salt } : {}),
	});
	if (!keyed.success) {
		deps.log(`pods cache skipped: ${keyed.error}`);
		return plainInstall(deps, target, opts, installEnv, keyed.error, t0);
	}
	const { key, xcodeVersion } = keyed.data;
	deps.log(`pods key ${key.slice(0, 8)} (${mode}) computed in ${deps.now() - keyStart} ms`);

	if (upToDate(target, key)) {
		touchPodsEntry(deps.store, key, deps.now());
		return ok({ kind: "up-to-date", key, mode, ms: deps.now() - t0 });
	}

	return withBuildLock(lockDeps(deps), podsLockKey(key), async () => {
		const entry = getPodsEntry(deps.store, key);
		if (entry && existsSync(podsEntryDir(deps.env, key))) {
			const restored = await restorePods(deps, entry, target);
			if (restored.success) {
				deps.log(`pods cache hit ${key.slice(0, 8)}: restored in ${deps.now() - t0} ms`);
				writeStamp(target, key);
				touchPodsEntry(deps.store, key, deps.now());
				return ok<PodsOutcome>({ kind: "hit", key, mode, ms: deps.now() - t0 });
			}
			deps.log(`pods cache entry ${key} unusable (${restored.error}); running pod install`);
			removePodsEntry(deps.store, deps.env, key);
		} else if (entry) {
			removePodsEntry(deps.store, deps.env, key);
		}

		const prebuilt = await prebuildIfNeeded(deps, target, installEnv, true);
		if (!prebuilt.success) return prebuilt;
		mkdirSync(podsRoot(deps.env), { recursive: true });
		const marker = join(podsRoot(deps.env), `.marker-${randomUUID()}`);
		writeFileSync(marker, "");
		try {
			const installed = await runPodInstall(deps, target, opts, installEnv);
			if (!installed.success) return installed;
			const stored = await snapshotPods(deps, { key, target, marker, podVersion, xcodeVersion });
			writeStamp(target, key);
			const ms = deps.now() - t0;
			if (stored.success) return ok<PodsOutcome>({ kind: "miss", key, mode, ms, stored: true });
			deps.log(`pods cache not stored: ${stored.error}`);
			return ok<PodsOutcome>({ kind: "miss", key, mode, ms, stored: false, storeError: stored.error });
		} finally {
			rmSync(marker, { force: true });
		}
	});
}
