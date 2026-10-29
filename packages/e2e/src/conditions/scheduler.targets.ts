import { bunExec } from "@delacour/warden-core/exec";
import { openAdbSession } from "../driver/android/adb-session";
import { geoFixArgv, geoFixFailure } from "../driver/android/android-argv";
import { realClock } from "../driver/android/android-device";
import { applyAndroidNetwork } from "../driver/android/android-network";
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
 * Which platforms a detached scheduler can drive. iOS is absent until the COND-5 network path is wired in:
 * add `ios: openIosTarget` here and `scheduler.main.ts` picks it up.
 */
export const schedulerTargets: Partial<Record<SchedulerPlatform, TargetOpener>> = {
	android: openAndroidTarget,
};
