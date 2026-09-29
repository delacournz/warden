import { type AsyncResult, err, ok, type Result } from "@warden/types/result";

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

export type EasStepOutcome = { kind: "hit"; path: string } | { kind: "miss"; reason: string };

/** Device half of the resolver — absent when only the artifact is wanted. */
export type DeviceSteps = {
	/** hash recorded in the `installs` table for this device + bundle id */
	installedHash: () => string | undefined;
	/** does the device really have the bundle id (simctl get_app_container / pm path)? */
	confirm: () => AsyncResult<boolean>;
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
	/** cached artifact path for `hash` (touches lastUsedAt) */
	cached: () => string | undefined;
	/** import `hash` from a legacy cache dir into the cache; path when found */
	legacy: () => AsyncResult<string | undefined>;
	/** serialise the fetch/build of `hash` across processes */
	lock: <T>(fn: () => AsyncResult<T>) => AsyncResult<T>;
	/** EAS: download into the cache, or miss */
	eas?: () => AsyncResult<EasStepOutcome>;
	/** local build into the cache; path */
	build?: () => AsyncResult<string>;
	log: (line: string) => void;
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
		return built.success ? ok({ path: built.data, source: "build" }) : built;
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
	return steps.lock(() => fetchOrBuild(steps));
}

async function alreadyInstalled(steps: ResolveSteps, device: DeviceSteps): Promise<Result<boolean>> {
	if (device.installedHash() !== steps.hash) return ok(false);
	const confirmed = await device.confirm();
	if (!confirmed.success) return confirmed;
	if (!confirmed.data) steps.log("install record is stale (app missing on device) — reinstalling");
	return ok(confirmed.data);
}

/**
 * The 5-step resolver, first hit wins: (1) already installed at this hash → nothing to do;
 * (2) warden cache; (3) legacy cache import; then under the build lock (4) EAS, (5) local build.
 * Whatever was found is installed on the device (a hash mismatch reinstalls). A new fingerprint
 * misses 1–3 by construction, so it never gets a stale binary.
 */
export async function resolveApp(steps: ResolveSteps): AsyncResult<EnsureResult> {
	const { device, hash } = steps;
	if (device) {
		const installed = await alreadyInstalled(steps, device);
		if (!installed.success) return installed;
		if (installed.data) return ok({ appPath: steps.cached() ?? "", hash, source: "installed", installed: true });
	}
	const found = await locate(steps);
	if (!found.success) return found;
	if (device) {
		const done = await device.install(found.data.path);
		if (!done.success) return done;
	}
	return ok({ appPath: found.data.path, hash, source: found.data.source, installed: device !== undefined });
}
