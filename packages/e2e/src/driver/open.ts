import { bunExec, type Exec } from "@delacour/warden-core/exec";
import type { E2eEnv } from "../env";
import type { DriverFactory } from "../session";
import type { Driver, DriverResult } from "./driver.types";
import { driverErr } from "./errors";
import { type OpenIosDriverOptions, openIosDriver } from "./ios/ios-driver";

/** Test seams for {@link openDriver}: everything {@link openIosDriver} injects except what the env supplies. */
export type OpenDriverDeps = Omit<OpenIosDriverOptions, "udid" | "env" | "exec"> & { exec?: Exec };

/** Open the `Driver` for the device in `env`, by platform. */
export async function openDriver(env: E2eEnv, deps: OpenDriverDeps = {}): DriverResult<Driver> {
	switch (env.platform) {
		case "ios":
			return openIosDriver({ ...deps, udid: env.udid, env, exec: deps.exec ?? bunExec });
		case "android":
			return driverErr("E_UNSUPPORTED", "Android driver lands in D9");
	}
}

/** What the session uses when no factory is passed; `preload.ts` registers it with `setDefaultDriverFactory`. */
export const defaultDriverFactory: DriverFactory = (env) => openDriver(env);
