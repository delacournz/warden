import { bunExec, type Exec } from "@delacour/warden-core/exec";
import { androidTools } from "@delacour/warden-core/providers/android";
import { wardenHome } from "@delacour/warden-core/store";
import type { E2eEnv } from "../env";
import type { DriverFactory } from "../session";
import { type AndroidDriverOptions, openAndroidDriver } from "./android/android-driver";
import { androidStateDir, createAndroidStateStore } from "./android/android-state";
import type { Driver, DriverResult } from "./driver.types";
import { type OpenIosDriverOptions, openIosDriver } from "./ios/ios-driver";

/**
 * Test seams for {@link openDriver}: everything the platform openers inject except what the env supplies.
 * `android` carries the Android-only seams (`adb` path, resident-shell spawn, binary runner, clock).
 */
export type OpenDriverDeps = Omit<OpenIosDriverOptions, "udid" | "env" | "exec"> & {
	exec?: Exec;
	android?: Omit<AndroidDriverOptions, "serial" | "exec" | "log" | "adb"> & { adb?: string };
};

/** `WARDEN_E2E_DEBUG=1` logs every helper op and simctl call with its duration to stderr. */
export const DEBUG_ENV = "WARDEN_E2E_DEBUG";

const stderrLog = (line: string): void => {
	process.stderr.write(`${line}\n`);
};

/**
 * The Android opener's options: the env's serial and app package, the `state` store under `<wardenHome>/android`
 * (a caller's own `android.state` wins) that remembers the dump route that worked and the animation scales to put
 * back, and the injected seams.
 */
function androidOptions(env: E2eEnv, deps: OpenDriverDeps, debug: boolean): AndroidDriverOptions {
	const android: NonNullable<OpenDriverDeps["android"]> = deps.android ?? {};
	const log = deps.log ?? (debug ? stderrLog : undefined);
	return {
		...android,
		serial: env.udid,
		adb: android.adb ?? androidTools(process.env).adb,
		exec: deps.exec ?? bunExec,
		appPackage: android.appPackage ?? env.bundleId,
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
		case "ios":
			return openIosDriver({
				...deps,
				udid: env.udid,
				env,
				exec: deps.exec ?? bunExec,
				debug,
				...(deps.log ? {} : debug ? { log: stderrLog } : {}),
			});
		case "android":
			return openAndroidDriver(androidOptions(env, deps, debug));
	}
}

/** What the session uses when no factory is passed; `preload.ts` registers it with `setDefaultDriverFactory`. */
export const defaultDriverFactory: DriverFactory = (env) => openDriver(env);
