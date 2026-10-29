import { bunExec } from "@delacour/warden-core/exec";
import { defaultDbPath, openStore, wardenHome } from "@delacour/warden-core/store";
import { openAdbSession } from "../driver/android/adb-session";
import { geoFixArgv, geoFixFailure } from "../driver/android/android-argv";
import { realClock } from "../driver/android/android-device";
import { applyAndroidNetwork } from "../driver/android/android-network";
import { driverErr } from "../driver/errors";
import { createInjectChannel, injectStatePath } from "../driver/ios/inject";
import { createIosNetwork } from "../driver/ios/ios-network";
import { locationClearArgv, locationSetArgv } from "../driver/ios/simctl";
import { leaseNetworkProxy } from "../driver/network-proxy";
import type { SchedulerTarget } from "./scheduler";
import type { SchedulerConfig, SchedulerPlatform } from "./scheduler.config";

const GEO_FIX_MS = 10_000;

export type OpenedTarget = { target: SchedulerTarget; close(): Promise<void> };

/** Opens the driver-like a detached scheduler drives on one platform. */
export type TargetOpener = (config: SchedulerConfig) => OpenedTarget;

/**
 * Android without the full driver (no animation changes, no uiad): the resident adb shell for network, `adb emu
 * geo fix` for a point. A route or GPX is the route ticker's job, so it is refused here.
 */
const openAndroidTarget: TargetOpener = (config) => {
	const adb = config.adb as string;
	const serial = config.id;
	const session = openAdbSession({ adb, serial });
	const target: SchedulerTarget = {
		network: async (condition) => {
			const res = await applyAndroidNetwork({ session, exec: bunExec, adb, serial, clock: realClock }, condition);
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
			const failure = geoFixFailure(await bunExec(geoFixArgv(adb, serial, op, op.altM), { timeoutMs: GEO_FIX_MS }));
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
const openIosTarget: TargetOpener = (config) => {
	const udid = config.id;
	const lease = config.lease;
	if (lease === undefined) throw new Error("scheduler: an ios target needs a lease");
	const env = process.env;
	const home = wardenHome(env);
	const store = openStore(defaultDbPath(env));
	const ios = createIosNetwork({
		proxy: leaseNetworkProxy({ store, env, now: () => Date.now() }, lease),
		channel: createInjectChannel({
			statePath: injectStatePath(home, udid),
			now: () => Date.now(),
			sleep: (ms) => Bun.sleep(ms),
		}),
		dylib: () => driverErr("E_INTERNAL", "the scheduler never launches an app"),
		isRunning: async () => ({ success: true, data: false }),
		lastBundle: () => config.bundleId,
		relaunch: async () => driverErr("E_UNSUPPORTED", "the scheduler never relaunches an app"),
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
					error: { message: `a ${op.kind} location cannot run inside a scheduler step; use \`location ${op.kind}\`` },
				};
			}
			const argv = op.kind === "clear" ? locationClearArgv(udid) : locationSetArgv(udid, op);
			const res = await bunExec(argv, { timeoutMs: GEO_FIX_MS });
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

/** Which platforms a detached scheduler can drive. */
export const schedulerTargets: Partial<Record<SchedulerPlatform, TargetOpener>> = {
	android: openAndroidTarget,
	ios: openIosTarget,
};
