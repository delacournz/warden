import type { SchedulerTarget } from "@delacour/warden-driver/conditions/scheduler";
import { driverErrors } from "@delacour/warden-driver/errors";
import { adbSessions } from "@delacour/warden-driver-android/adb-session";
import { androidArgv } from "@delacour/warden-driver-android/android-argv";
import { realClock } from "@delacour/warden-driver-android/android-device";
import { AndroidNetwork } from "@delacour/warden-driver-android/android-network";
import { FileInjectChannel, injectProtocol } from "@delacour/warden-driver-ios/inject";
import { IosNetworkController } from "@delacour/warden-driver-ios/ios-network";
import { simctlArgv } from "@delacour/warden-driver-ios/simctl";
import { processExec } from "@delacour/warden-runtime/exec";
import { storeLocator } from "@delacour/warden-store/store";
import { LeaseNetworkProxy } from "./lease-network-proxy";
import type { SchedulerConfig, SchedulerPlatform } from "./scheduler.config";

const GEO_FIX_MS = 10_000;

export type OpenedTarget = { target: SchedulerTarget; close(): Promise<void> };

/** Opens the driver-like a detached scheduler drives on one platform. */
export type TargetOpener = (config: SchedulerConfig) => OpenedTarget;

/** The driver-likes a detached scheduler can drive, per platform. */
export class SchedulerTargets {
	/** Which platforms a detached scheduler can drive: the opener for `platform`, if there is one. */
	opener(platform: SchedulerPlatform): TargetOpener | undefined {
		if (platform === "android") return this.openAndroid;
		if (platform === "ios") return this.openIos;
		return undefined;
	}

	/**
	 * Android without the full driver (no animation changes, no uiad): the resident adb shell for network, `adb emu
	 * geo fix` for a point. A route or GPX is the route ticker's job, so it is refused here.
	 */
	readonly openAndroid: TargetOpener = (config) => {
		const adb = config.adb as string;
		const serial = config.id;
		const session = adbSessions.open({ adb, serial });
		const target: SchedulerTarget = {
			network: async (condition) => {
				const res = await new AndroidNetwork({
					session,
					exec: processExec.run,
					adb,
					serial,
					clock: realClock,
				}).apply(condition);
				return res.success ? { success: true } : res;
			},
			location: async (op) => {
				if (op.kind === "clear") return { success: true };
				if (op.kind !== "point") {
					return {
						success: false,
						error: { message: `a ${op.kind} location cannot run inside a scheduler step; use the route ticker` },
					};
				}
				const failure = androidArgv.geoFixFailure(
					await processExec.run(androidArgv.geoFixArgv(adb, serial, op, op.altM), { timeoutMs: GEO_FIX_MS })
				);
				return failure === undefined ? { success: true } : { success: false, error: { message: failure } };
			},
		};
		return { target, close: () => session.close() };
	};

	/**
	 * iOS without the driver: the network steps go through the lease's shaping proxy and the dylib's state file
	 * (`createIosNetwork`, the same layer the driver uses), a point through `simctl location`. The app is not
	 * relaunched: a step that cannot reach a running, un-injected app is staged for its next launch.
	 */
	readonly openIos: TargetOpener = (config) => {
		const udid = config.id;
		const lease = config.lease;
		if (lease === undefined) throw new Error("scheduler: an ios target needs a lease");
		const env = process.env;
		const home = storeLocator.wardenHome(env);
		const store = storeLocator.open(storeLocator.defaultDbPath(env));
		const ios = new IosNetworkController({
			proxy: new LeaseNetworkProxy(
				{ store, env, now: () => Date.now(), ...(config.proxyCommand ? { command: config.proxyCommand } : {}) },
				lease
			),
			channel: new FileInjectChannel({
				statePath: injectProtocol.statePath(home, udid),
				now: () => Date.now(),
				sleep: (ms) => Bun.sleep(ms),
			}),
			dylib: () => driverErrors.err("E_INTERNAL", "the scheduler never launches an app"),
			isRunning: async () => ({ success: true, data: false }),
			lastBundle: () => config.bundleId,
			relaunch: async () => driverErrors.err("E_UNSUPPORTED", "the scheduler never relaunches an app"),
		});
		const target: SchedulerTarget = {
			network: async (condition) => {
				const res = await ios.network(condition);
				return res.success ? { success: true } : { success: false, error: { message: res.error.message } };
			},
			location: async (op) => {
				if (op.kind !== "point" && op.kind !== "clear") {
					return {
						success: false,
						error: {
							message: `a ${op.kind} location cannot run inside a scheduler step; use \`location ${op.kind}\``,
						},
					};
				}
				const argv = op.kind === "clear" ? simctlArgv.locationClear(udid) : simctlArgv.locationSet(udid, op);
				const res = await processExec.run(argv, { timeoutMs: GEO_FIX_MS });
				return res.exitCode === 0
					? { success: true }
					: { success: false, error: { message: `simctl location exited ${res.exitCode}: ${res.stderr.trim()}` } };
			},
		};
		return {
			target,
			close: async () => {
				store.close();
			},
		};
	};
}

export const schedulerTargets = new SchedulerTargets();
