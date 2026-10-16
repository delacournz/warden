import { bunExec, type Exec } from "@delacour/warden-core/exec";
import { androidTools } from "@delacour/warden-core/providers/android";
import type { E2eEnv } from "../env";
import type { DriverFactory } from "../session";
import { type AndroidDriverOptions, openAndroidDriver } from "./android/android-driver";
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

/** Open the `Driver` for the device in `env`, by platform. */
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
		case "android": {
			const android: NonNullable<OpenDriverDeps["android"]> = deps.android ?? {};
			const log = deps.log ?? (debug ? stderrLog : undefined);
			return openAndroidDriver({
				...android,
				serial: env.udid,
				adb: android.adb ?? androidTools(process.env).adb,
				exec: deps.exec ?? bunExec,
				...(log ? { log } : {}),
			});
		}
	}
}

/** What the session uses when no factory is passed; `preload.ts` registers it with `setDefaultDriverFactory`. */
export const defaultDriverFactory: DriverFactory = (env) => openDriver(env);
