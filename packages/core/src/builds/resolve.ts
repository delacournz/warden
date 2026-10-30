import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import type { Platform } from "../types";
import type { InstallMode } from "./app-option.schema";

/** Where `ensure` found the app. */
export type ResolveSource = "installed" | "cache" | "eas" | "build";

export type EnsureResult = {
	/** cached `.app`/`.apk` ("" only when already installed and the cache no longer has it) */
	appPath: string;
	hash: string;
	source: ResolveSource;
	/** the app is on the device at `hash` (false when no device was given) */
	installed: boolean;
};

/**
 * What a resolve is doing right now, for a progress display: `fetching` the EAS build, `waiting` on another device's
 * (or process's) fetch / build of the same hash, `building` locally, `repacking` JS into the simulator base,
 * `installing` on a device (only while an install really runs), `ready` when the resolve is done.
 */
export type AppPhase =
	| { phase: "fetching"; source: "eas" }
	| { phase: "waiting" }
	| { phase: "building"; platform: Platform; hash: string }
	| { phase: "repacking"; platform: Platform; jsKey: string }
	| { phase: "installing" }
	| { phase: "ready" };

export type EasStepOutcome = { kind: "hit"; path: string } | { kind: "miss"; reason: string };

/** What the local build step produced: its own build, or (after waiting on the checkout) another warden's, from the cache. */
export type BuildStepOutcome = { kind: "built"; path: string } | { kind: "cached"; path: string };

/** What the device probe found: is the app there, and (iOS) its container so `matches` need not ask again. */
export type InstalledApp = { present: boolean; container?: string };

/** Device half of the resolver — absent when only the artifact is wanted. */
export type DeviceSteps = {
	/** hash recorded in the `installs` table for this device + bundle id */
	installedHash: () => string | undefined;
	/** does the device really have the bundle id (simctl get_app_container / pm path)? */
	confirm: () => AsyncResult<InstalledApp>;
	/** does the installed app (as `confirm` found it) match the cached build at `cachedPath` (CFBundleVersion + binary)? Absent = trust the record. */
	matches?: (cachedPath: string, installed: InstalledApp) => AsyncResult<boolean>;
	/** remove the app (and its data) so the install starts fresh; absent is fine */
	uninstall: () => AsyncResult<void>;
	/** `installMode: "clean"`: wipe the installed app's data (and the keychain when asked), keeping the binary */
	reset: () => AsyncResult<void>;
	/** install + record in `installs` */
	install: (appPath: string) => AsyncResult<void>;
};

/**
 * The resolver's effects, each a thin closure — tests pass fakes. `eas` / `build` absent means
 * skipped (`--no-eas` / `--no-build`, or EAS not configured).
 */
export type ResolveSteps = {
	hash: string;
	device?: DeviceSteps;
	/** `clean`: fresh app data without reinstalling an unchanged build; `reinstall`: uninstall + install even at `hash`; unset: install only when `hash` differs */
	installMode?: InstallMode;
	/** cached artifact path for `hash` (touches lastUsedAt) */
	cached: () => string | undefined;
	/** import `hash` from a legacy cache dir into the cache; path when found */
	legacy: () => AsyncResult<string | undefined>;
	/** serialise the fetch/build of `hash` across processes */
	lock: <T>(fn: () => AsyncResult<T>) => AsyncResult<T>;
	/**
	 * Same-process single flight: concurrent `resolveApp`s with this key (one per device of a session)
	 * share the first one's locked fetch/build and its result, success or error; only other processes
	 * wait on the build lock. Absent: every call takes the lock itself.
	 */
	flightKey?: string;
	/** EAS: download into the cache, or miss */
	eas?: () => AsyncResult<EasStepOutcome>;
	/** local build into the cache (or the build another warden just made in this checkout) */
	build?: () => AsyncResult<BuildStepOutcome>;
	log: (line: string) => void;
	/** progress: where this resolve is (see `AppPhase`) */
	onPhase?: (phase: AppPhase) => void;
};

type Found = { path: string; source: Exclude<ResolveSource, "installed"> };

/** Steps 4–5 under the build lock: re-check the cache (another process may have filled it), EAS, local. */
async function fetchOrBuild(steps: ResolveSteps): AsyncResult<Found> {
	const again = steps.cached();
	if (again) return ok({ path: again, source: "cache" });
	const misses: string[] = [];
	if (steps.eas) {
		const eas = await steps.eas();
		if (!eas.success) return eas;
		if (eas.data.kind === "hit") return ok({ path: eas.data.path, source: "eas" });
		steps.log(`EAS: ${eas.data.reason}`);
		misses.push(`EAS: ${eas.data.reason}`);
	} else {
		misses.push("EAS skipped");
	}
	if (steps.build) {
		const built = await steps.build();
		if (!built.success) return built;
		return ok({ path: built.data.path, source: built.data.kind === "built" ? "build" : "cache" });
	}
	misses.push("local build skipped (--no-build)");
	return err(`no build for fingerprint ${steps.hash}: ${misses.join("; ")}`);
}

async function locate(steps: ResolveSteps): AsyncResult<Found> {
	const cached = steps.cached();
	if (cached) return ok({ path: cached, source: "cache" });
	const legacy = await steps.legacy();
	if (!legacy.success) return legacy;
	if (legacy.data) {
		steps.log(`imported legacy build ${legacy.data}`);
		return ok({ path: legacy.data, source: "cache" });
	}
	return fetchOrBuildOnce(steps);
}

/** In-flight locked fetch/builds of this process, by `ResolveSteps.flightKey`. */
const inFlight = new Map<string, AsyncResult<Found>>();

function fetchOrBuildOnce(steps: ResolveSteps): AsyncResult<Found> {
	const key = steps.flightKey;
	if (key === undefined) return steps.lock(() => fetchOrBuild(steps));
	const running = inFlight.get(key);
	if (running) {
		steps.log("this fetch/build is already running for another device — waiting for it");
		steps.onPhase?.({ phase: "waiting" });
		return running;
	}
	const started = steps.lock(() => fetchOrBuild(steps));
	inFlight.set(key, started);
	const done = () => {
		inFlight.delete(key);
	};
	started.then(done, done);
	return started;
}

async function alreadyInstalled(steps: ResolveSteps, device: DeviceSteps): Promise<Result<boolean>> {
	if (device.installedHash() !== steps.hash) return ok(false);
	const confirmed = await device.confirm();
	if (!confirmed.success) return confirmed;
	if (!confirmed.data.present) {
		steps.log("install record is stale (app missing on device) — reinstalling");
		return ok(false);
	}
	const cached = device.matches ? steps.cached() : undefined;
	if (device.matches && cached) {
		const same = await device.matches(cached, confirmed.data);
		if (!same.success) return same;
		if (!same.data) steps.log("app on device differs from the cached build — reinstalling");
		return ok(same.data);
	}
	return ok(true);
}

/** `reinstall`: uninstall first; `clean`: install over, then reset (falling back to uninstall + install); else install over. */
async function installOnDevice(steps: ResolveSteps, device: DeviceSteps, path: string): AsyncResult<void> {
	if (steps.installMode === "reinstall") return reinstall(device, path);
	const done = await device.install(path);
	if (!done.success || steps.installMode !== "clean") return done;
	return resetOrReinstall(steps, device, path);
}

async function reinstall(device: DeviceSteps, path: string): AsyncResult<void> {
	const gone = await device.uninstall();
	return gone.success ? device.install(path) : gone;
}

/** Reset the app's data; when that fails, start over with an uninstall + install of `path`. */
async function resetOrReinstall(steps: ResolveSteps, device: DeviceSteps, path: string): AsyncResult<void> {
	const reset = await device.reset();
	if (reset.success) return reset;
	steps.log(`resetting app data failed (${reset.error}) — reinstalling`);
	return reinstall(device, path);
}

/** Already at `hash`: keep the install; `clean` resets its data, falling back to uninstall + install. */
async function keepInstalled(steps: ResolveSteps, device: DeviceSteps): AsyncResult<EnsureResult> {
	const kept: EnsureResult = { appPath: steps.cached() ?? "", hash: steps.hash, source: "installed", installed: true };
	if (steps.installMode !== "clean") return ok(kept);
	const reset = await device.reset();
	if (reset.success) return ok(kept);
	steps.log(`resetting app data failed (${reset.error}) — reinstalling`);
	return reinstallFound(steps, device);
}

/** The `clean` fallback for an app already at `hash`: locate the artifact again, then uninstall + install it. */
async function reinstallFound(steps: ResolveSteps, device: DeviceSteps): AsyncResult<EnsureResult> {
	const found = await locate(steps);
	if (!found.success) return found;
	const done = await reinstall(device, found.data.path);
	if (!done.success) return done;
	return ok({ appPath: found.data.path, hash: steps.hash, source: found.data.source, installed: true });
}

/**
 * The 5-step resolver, first hit wins: (1) already installed at this hash → nothing to do;
 * (2) warden cache; (3) legacy cache import; then under the build lock (4) EAS, (5) local build.
 * Whatever was found is installed over the old app (a hash mismatch reinstalls). `installMode: "clean"` keeps
 * step 1 but resets the app's data either way; `reinstall` skips step 1 and uninstalls first. A new fingerprint
 * misses 1–3 by construction, so it never gets a stale binary.
 */
export async function resolveApp(steps: ResolveSteps): AsyncResult<EnsureResult> {
	const resolved = await resolveInner(steps);
	if (resolved.success) steps.onPhase?.({ phase: "ready" });
	return resolved;
}

async function resolveInner(steps: ResolveSteps): AsyncResult<EnsureResult> {
	const { device, hash } = steps;
	if (device && steps.installMode !== "reinstall") {
		const installed = await alreadyInstalled(steps, device);
		if (!installed.success) return installed;
		if (installed.data) return keepInstalled(steps, device);
	}
	const found = await locate(steps);
	if (!found.success) return found;
	if (device) {
		steps.onPhase?.({ phase: "installing" });
		const done = await installOnDevice(steps, device, found.data.path);
		if (!done.success) return done;
	}
	return ok({ appPath: found.data.path, hash, source: found.data.source, installed: device !== undefined });
}
