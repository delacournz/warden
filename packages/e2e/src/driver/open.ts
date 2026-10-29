import { bunExec, type Exec } from "@delacour/warden-core/exec";
import { androidTools } from "@delacour/warden-core/providers/android";
import { wardenHome } from "@delacour/warden-core/store";
import { type StoreOpener, sharedStoreOpener } from "../conditions/lease-store";
import type { E2eEnv } from "../env";
import type { DriverFactory } from "../session";
import { type AndroidDriverOptions, openAndroidDriver } from "./android/android-driver";
import { androidStateDir, createAndroidStateStore } from "./android/android-state";
import { uiadFromEnv } from "./android/uiad-backend";
import { type ClockRecorder, leaseClockRecorder } from "./clock-recorder";
import type { Driver, DriverResult } from "./driver.types";
import { type OpenIosDriverOptions, openIosDriver } from "./ios/ios-driver";
import { lazyLeaseNetworkProxy, type NetworkProxyPort } from "./network-proxy";

/**
 * Test seams for {@link openDriver}: everything the platform openers inject except what the env supplies.
 * `android` carries the Android-only seams (`adb` path, resident-shell spawn, binary runner, clock).
 */
export type OpenDriverDeps = Omit<OpenIosDriverOptions, "udid" | "env" | "exec"> & {
	exec?: Exec;
	android?: Omit<AndroidDriverOptions, "serial" | "exec" | "log" | "adb"> & { adb?: string };
	/** opens the lease store for the shaping proxy; default: the spec process's shared connection */
	openStore?: StoreOpener;
};

/**
 * The shaping proxy of the spec's lease (`WARDEN_LEASE_ID`), built lazily: nothing opens the store or starts a
 * process until a network condition asks for it. None without a lease id, so `network` answers `E_UNSUPPORTED`.
 */
export function leaseProxyFor(env: E2eEnv, deps: OpenDriverDeps = {}): NetworkProxyPort | undefined {
	if (env.leaseId === undefined) return undefined;
	return lazyLeaseNetworkProxy({
		leaseId: env.leaseId,
		env: process.env,
		now: Date.now,
		openStore: deps.openStore ?? sharedStoreOpener(process.env),
		command: env.netproxyCommand,
	});
}

/**
 * Records the clock the driver sets on the spec's lease (`leaseClockRecorder`), opening the store on the first
 * change. Best effort: a store that fails is logged and never fails the clock call. None without a lease id.
 */
export function leaseClockRecorderFor(env: E2eEnv, deps: OpenDriverDeps = {}): ClockRecorder | undefined {
	const leaseId = env.leaseId;
	if (leaseId === undefined) return undefined;
	const open = deps.openStore ?? sharedStoreOpener(process.env);
	return (condition) => {
		try {
			const store = open();
			if (!store.success) throw new Error(store.error);
			leaseClockRecorder(store.data, leaseId)(condition);
		} catch (error) {
			stderrLog(
				`[warden-e2e] could not record the clock condition on lease ${leaseId}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	};
}

/** `WARDEN_E2E_DEBUG=1` logs every helper op and simctl call with its duration to stderr. */
export const DEBUG_ENV = "WARDEN_E2E_DEBUG";

const stderrLog = (line: string): void => {
	process.stderr.write(`${line}\n`);
};

/**
 * The Android opener's options: the env's serial and app package, the `state` store under `<wardenHome>/android`
 * (a caller's own `android.state` wins) that remembers the dump route that worked and the animation scales to put
 * back, the resident `warden-uiad` server (unless `WARDEN_ANDROID_UIAD=0`, a caller's own `android.uiad`, or an injected
 * shell `spawn`, which is a test that must never reach a real `adb`), and the injected seams.
 */
export function androidOptions(env: E2eEnv, deps: OpenDriverDeps, debug: boolean): AndroidDriverOptions {
	const android: NonNullable<OpenDriverDeps["android"]> = deps.android ?? {};
	const log = deps.log ?? (debug ? stderrLog : undefined);
	const networkProxy = android.networkProxy ?? leaseProxyFor(env, deps);
	const clockRecorder = android.clockRecorder ?? leaseClockRecorderFor(env, deps);
	return {
		...android,
		...(networkProxy === undefined ? {} : { networkProxy }),
		...(clockRecorder === undefined ? {} : { clockRecorder }),
		serial: env.udid,
		adb: android.adb ?? androidTools(process.env).adb,
		exec: deps.exec ?? bunExec,
		appPackage: android.appPackage ?? env.bundleId,
		...(android.uiad === undefined && android.spawn === undefined ? { uiad: uiadFromEnv(process.env) } : {}),
		state:
			android.state ??
			createAndroidStateStore({
				dir: androidStateDir(deps.wardenHome ?? wardenHome(process.env)),
				...(log ? { log } : {}),
			}),
		...(log ? { log } : {}),
	};
}

/** Open the `Driver` for the device in `env`, by platform. Android deep links go to `env.bundleId` only. */
export async function openDriver(env: E2eEnv, deps: OpenDriverDeps = {}): DriverResult<Driver> {
	const debug = deps.debug ?? process.env[DEBUG_ENV] === "1";
	switch (env.platform) {
		case "ios": {
			const networkProxy = deps.networkProxy ?? leaseProxyFor(env, deps);
			const clockRecorder = deps.clockRecorder ?? leaseClockRecorderFor(env, deps);
			return openIosDriver({
				...deps,
				...(networkProxy === undefined ? {} : { networkProxy }),
				...(clockRecorder === undefined ? {} : { clockRecorder }),
				udid: env.udid,
				env,
				exec: deps.exec ?? bunExec,
				debug,
				...(deps.log ? {} : debug ? { log: stderrLog } : {}),
			});
		}
		case "android":
			return openAndroidDriver(androidOptions(env, deps, debug));
	}
}

/** What the session uses when no factory is passed; `preload.ts` registers it with `setDefaultDriverFactory`. */
export const defaultDriverFactory: DriverFactory = (env) => openDriver(env);
