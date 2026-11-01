import type { ClockRecorder } from "@delacour/warden-driver/clock-recorder";
import type { Driver, DriverResult } from "@delacour/warden-driver/driver.types";
import type { NetworkProxyPort } from "@delacour/warden-driver/network-proxy";
import { type AndroidDriverOptions, openAndroidDriver } from "@delacour/warden-driver-android/android-driver";
import { androidStateDir, createAndroidStateStore } from "@delacour/warden-driver-android/android-state";
import { type OpenIosDeviceDriverOptions, openIosDeviceDriver } from "@delacour/warden-driver-ios/device/device-driver";
import { type OpenIosDriverOptions, openIosDriver } from "@delacour/warden-driver-ios/ios-driver";
import { bunExec, type Exec } from "@delacour/warden-runtime/exec";
import { leaseModel } from "@delacour/warden-store/types";

/**
 * Everything {@link openDriver} needs, as values: it reads no environment variable and no global. The edge
 * ({@link openDriverFromEnv}, `warden ui`, an SDK host) turns its env into these.
 */
export type OpenDriverOptions = {
	platform: "ios" | "android";
	/** the udid (iOS) or adb serial (Android) of the leased device */
	id: string;
	/** the app under test: Android deep links go to this package only */
	appId?: string;
	/**
	 * The parts of a `WardenHost` the opener uses: the process runner (default `bunExec`) and the warden home
	 * (`$WARDEN_HOME`; without it the Android per-device state is not saved and the iOS staged helper is not looked up).
	 */
	host?: { exec?: Exec; home?: string };
	log?: (line: string) => void;
	/** log every helper op and simctl call with its duration to stderr when no `log` is given */
	debug?: boolean;
	/**
	 * iOS: `simdPath` is `WARDEN_SIMD` (a file; set and missing is an error), `helperDir` is `WARDEN_HELPER_DIR`,
	 * `socketPath` is `WARDEN_SIMD_SOCKET`. The rest are the opener's test seams.
	 */
	ios?: { simdPath?: string; helperDir?: string; socketPath?: string } & Omit<
		OpenIosDriverOptions,
		"udid" | "env" | "exec" | "log" | "debug" | "wardenHome" | "socketPath"
	>;
	/**
	 * Android: `adb` is the binary (default `adb` on the PATH), `uiad` the resident `warden-uiad` server (default on,
	 * unless a shell `spawn` is injected, which is a test that must never reach a real `adb`; `false` switches it off).
	 */
	android?: Omit<AndroidDriverOptions, "serial" | "exec" | "log" | "adb"> & { adb?: string };
	/**
	 * A physical iPhone (a udid that is a device id, not a simulator's): `runnerSocket` is the runner host's socket
	 * (`WARDEN_IOS_RUNNER_SOCKET`), `appPath` the build `clearData` reinstalls, `ownedBundles` the bundle ids warden
	 * installed on the phone earlier (the only others `app.uninstall` may touch). The rest are the opener's test seams.
	 */
	iosDevice?: { runnerSocket?: string; appPath?: string } & Omit<
		OpenIosDeviceDriverOptions,
		"udid" | "exec" | "log" | "env" | "socketPath" | "appPath" | "bundleId"
	>;
	/** the lease's shaping proxy; without it `network` answers `E_UNSUPPORTED` (a bare caller has no lease to hang one on) */
	networkProxy?: NetworkProxyPort;
	/** told about every successful `clock` op, so the lease records the `clock` area */
	clockRecorder?: ClockRecorder;
};

const stderrLog = (line: string): void => {
	process.stderr.write(`${line}\n`);
};

/** The lease's proxy and clock recorder, unless the platform opener's own seams already name one. */
function leaseSeams(
	options: Pick<OpenDriverOptions, "networkProxy" | "clockRecorder">,
	own: Pick<OpenDriverOptions, "networkProxy" | "clockRecorder">
): Pick<OpenDriverOptions, "networkProxy" | "clockRecorder"> {
	const networkProxy = own.networkProxy ?? options.networkProxy;
	const clockRecorder = own.clockRecorder ?? options.clockRecorder;
	return {
		...(networkProxy === undefined ? {} : { networkProxy }),
		...(clockRecorder === undefined ? {} : { clockRecorder }),
	};
}

/**
 * The Android opener's options: the serial and app package, the `state` store under `<home>/android` (a caller's own
 * `android.state` wins) that remembers the dump route that worked and the animation scales to put back, the resident
 * `warden-uiad` server (unless the caller said otherwise or injected a shell `spawn`), and the injected seams.
 */
export function androidOptions(options: OpenDriverOptions, debug: boolean): AndroidDriverOptions {
	const android: NonNullable<OpenDriverOptions["android"]> = options.android ?? {};
	const log = options.log ?? (debug ? stderrLog : undefined);
	const home = options.host?.home;
	const state =
		android.state ??
		(home === undefined ? undefined : createAndroidStateStore({ dir: androidStateDir(home), ...(log ? { log } : {}) }));
	const appPackage = android.appPackage ?? options.appId;
	return {
		...android,
		...leaseSeams(options, android),
		serial: options.id,
		adb: android.adb ?? "adb",
		exec: options.host?.exec ?? bunExec,
		...(appPackage === undefined ? {} : { appPackage }),
		...(android.uiad === undefined && android.spawn === undefined ? { uiad: true } : {}),
		...(state === undefined ? {} : { state }),
		...(log ? { log } : {}),
	};
}

/** The iOS opener's options: the helper locations as the env-shaped names `openIosDriver` reads, and the injected seams. */
function iosOptions(options: OpenDriverOptions, debug: boolean): OpenIosDriverOptions {
	const { simdPath, helperDir, socketPath, ...seams } = options.ios ?? {};
	const home = options.host?.home;
	return {
		...seams,
		...leaseSeams(options, seams),
		...(seams.bundleId === undefined && options.appId !== undefined ? { bundleId: options.appId } : {}),
		udid: options.id,
		env: {
			...(simdPath === undefined ? {} : { simd: simdPath }),
			...(helperDir === undefined ? {} : { helperDir }),
			...(socketPath === undefined ? {} : { simdSocket: socketPath }),
		},
		exec: options.host?.exec ?? bunExec,
		debug,
		...(home === undefined ? {} : { wardenHome: home }),
		...(options.log ? { log: options.log } : debug ? { log: stderrLog } : {}),
	};
}

/** The physical iPhone opener's options: the runner socket, app and bundle id, and the injected seams. */
function iosDeviceOptions(options: OpenDriverOptions, debug: boolean): OpenIosDeviceDriverOptions {
	const { runnerSocket, appPath, ...seams } = options.iosDevice ?? {};
	return {
		...seams,
		udid: options.id,
		exec: options.host?.exec ?? bunExec,
		...(runnerSocket === undefined ? {} : { socketPath: runnerSocket }),
		...(appPath === undefined ? {} : { appPath }),
		...(options.appId === undefined ? {} : { bundleId: options.appId }),
		...(options.log ? { log: options.log } : debug ? { log: stderrLog } : {}),
	};
}

/** Open the `Driver` for the device in `options`, by platform. Reads no environment: see {@link openDriverFromEnv}. */
export async function openDriver(options: OpenDriverOptions): DriverResult<Driver> {
	const debug = options.debug ?? false;
	switch (options.platform) {
		case "ios":
			if (leaseModel.isPhysicalIosId(options.id)) return openIosDeviceDriver(iosDeviceOptions(options, debug));
			return openIosDriver(iosOptions(options, debug));
		case "android":
			return openAndroidDriver(androidOptions(options, debug));
	}
}
