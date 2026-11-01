import { leaseClockRecorder } from "@delacour/warden-device/conditions/lease-clock-recorder";
import { lazyLeaseNetworkProxy } from "@delacour/warden-device/conditions/lease-network-proxy";
import { type StoreOpener, sharedStoreOpener } from "@delacour/warden-device/conditions/lease-store";
import { type OpenDriverOptions, openDriver } from "@delacour/warden-device/open";
import type { ClockRecorder } from "@delacour/warden-driver/clock-recorder";
import type { Driver, DriverResult } from "@delacour/warden-driver/driver.types";
import type { NetworkProxyPort } from "@delacour/warden-driver/network-proxy";
import { uiadFromEnv } from "@delacour/warden-driver-android/uiad-backend";
import { androidTools } from "@delacour/warden-providers/android-tools";
import { storeLocator } from "@delacour/warden-store/store";
import type { E2eEnv } from "./env";
import type { DriverFactory } from "./session";

type Env = Readonly<Record<string, string | undefined>>;

/** `WARDEN_E2E_DEBUG=1` logs every helper op and simctl call with its duration to stderr. */
export const DEBUG_ENV = "WARDEN_E2E_DEBUG";

/** What {@link openDriverFromEnv} lets a caller replace: everything but the device, which `env` names. */
export type OpenDriverFromEnvOptions = Omit<OpenDriverOptions, "platform" | "id" | "appId"> & {
	/** the process environment the warden variables are read from; default `process.env` */
	processEnv?: Env;
	/** opens the lease store for the shaping proxy and the clock recorder; default: the spec process's shared connection */
	openStore?: StoreOpener;
};

const stderrLog = (line: string): void => {
	process.stderr.write(`${line}\n`);
};

/**
 * The shaping proxy of the spec's lease (`WARDEN_LEASE_ID`), built lazily: nothing opens the store or starts a
 * process until a network condition asks for it. None without a lease id, so `network` answers `E_UNSUPPORTED`.
 */
export function leaseProxyFor(
	env: Pick<E2eEnv, "leaseId" | "netproxyCommand">,
	options: Pick<OpenDriverFromEnvOptions, "openStore" | "processEnv"> = {}
): NetworkProxyPort | undefined {
	if (env.leaseId === undefined) return undefined;
	const processEnv = options.processEnv ?? process.env;
	return lazyLeaseNetworkProxy({
		leaseId: env.leaseId,
		env: { ...processEnv },
		now: Date.now,
		openStore: options.openStore ?? sharedStoreOpener(processEnv),
		command: env.netproxyCommand,
	});
}

/**
 * Records the clock the driver sets on the spec's lease (`leaseClockRecorder`), opening the store on the first
 * change. Best effort: a store that fails is logged and never fails the clock call. None without a lease id.
 */
export function leaseClockRecorderFor(
	env: Pick<E2eEnv, "leaseId">,
	options: Pick<OpenDriverFromEnvOptions, "openStore" | "processEnv"> = {}
): ClockRecorder | undefined {
	const leaseId = env.leaseId;
	if (leaseId === undefined) return undefined;
	const open = options.openStore ?? sharedStoreOpener(options.processEnv ?? process.env);
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

/**
 * Open the `Driver` for the device in `env`: the edge that turns `WARDEN_*` (the spec process's env, `env`) and the
 * process environment (`ANDROID_HOME`, `WARDEN_HOME`, `WARDEN_ANDROID_UIAD`, `WARDEN_E2E_DEBUG`) into
 * {@link openDriver}'s values. Anything in `options` wins over what the environment says.
 */
export async function openDriverFromEnv(env: E2eEnv, options: OpenDriverFromEnvOptions = {}): DriverResult<Driver> {
	const { processEnv = process.env, openStore, ...rest } = options;
	const lease = { processEnv, ...(openStore === undefined ? {} : { openStore }) };
	const networkProxy = rest.networkProxy ?? leaseProxyFor(env, lease);
	const clockRecorder = rest.clockRecorder ?? leaseClockRecorderFor(env, lease);
	return openDriver({
		...rest,
		...(networkProxy === undefined ? {} : { networkProxy }),
		...(clockRecorder === undefined ? {} : { clockRecorder }),
		platform: env.platform,
		id: env.udid,
		appId: env.bundleId,
		debug: rest.debug ?? processEnv[DEBUG_ENV] === "1",
		host: { home: storeLocator.wardenHome(processEnv), ...rest.host },
		ios: {
			...(env.simd === undefined ? {} : { simdPath: env.simd }),
			...(env.helperDir === undefined ? {} : { helperDir: env.helperDir }),
			...(env.simdSocket === undefined ? {} : { socketPath: env.simdSocket }),
			...rest.ios,
		},
		iosDevice: {
			...(env.iosRunnerSocket === undefined ? {} : { runnerSocket: env.iosRunnerSocket }),
			...(env.appPath === undefined ? {} : { appPath: env.appPath }),
			...rest.iosDevice,
		},
		android: {
			adb: androidTools(processEnv).adb,
			uiad: uiadFromEnv(processEnv) ?? false,
			...rest.android,
		},
	});
}

/** What the session uses when no factory is passed; `preload.ts` registers it with `setDefaultDriverFactory`. */
export const defaultDriverFactory: DriverFactory = (env) => openDriverFromEnv(env);
