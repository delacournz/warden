import type { Driver, LaunchOptions } from "./driver/driver.types";
import { unwrap } from "./driver/unwrap";
import type { E2eEnv } from "./env";
import { E2eError } from "./errors";
import type { FixtureSession } from "./fixture-session";

export type OpenOptions = {
	/** opened with `driver.app.openUrl` once the app is launched */
	url?: string;
	/** appended after `WARDEN_LAUNCH_ARGS` */
	args?: readonly string[];
	env?: Record<string, string>;
};

/** The app under test (`WARDEN_BUNDLE_ID`). */
export type App = {
	/**
	 * Launches the app (terminating a running instance first) with `WARDEN_LAUNCH_ARGS` + `args`, then
	 * opens `url` if given. The runner calls this for the per-test `launch: "fresh"` default.
	 */
	open(options?: OpenOptions): Promise<void>;
	close(): Promise<void>;
	/** terminate, then launch again with `WARDEN_LAUNCH_ARGS` */
	restart(): Promise<void>;
	/** uninstall (when installed) and install again from `WARDEN_APP_PATH` */
	reinstall(): Promise<void>;
	/**
	 * Wipes app data but keeps the build. Always asks for the keychain to be reset as well: the iOS
	 * driver maps this to core `resetAppData` with `resetKeychain`, Android to `pm clear`.
	 */
	clearData(): Promise<void>;
	isRunning(): Promise<boolean>;
};

export type AppDeps = {
	session: FixtureSession;
	driver: Driver;
	env: E2eEnv;
};

export function createApp({ session, driver, env }: AppDeps): App {
	const bundleId = env.bundleId;
	const launch = async (options: OpenOptions = {}): Promise<void> => {
		const opts: LaunchOptions = {
			args: [...env.launchArgs, ...(options.args ?? [])],
			relaunch: true,
		};
		if (options.env !== undefined) opts.env = options.env;
		await unwrap(() => driver.app.launch(bundleId, opts), `launch ${bundleId}`, session.signal);
		if (options.url !== undefined) {
			const url = options.url;
			await unwrap(() => driver.app.openUrl(url), `open ${url}`, session.signal);
		}
	};

	const terminate = (): Promise<void> =>
		unwrap(() => driver.app.terminate(bundleId), `terminate ${bundleId}`, session.signal);

	return {
		open: launch,
		close: terminate,
		async restart() {
			await terminate();
			await launch();
		},
		async reinstall() {
			const path = env.appPath;
			if (path === undefined) {
				throw new E2eError(
					"INVALID_ARGUMENT",
					"app.reinstall() needs WARDEN_APP_PATH (the build to install) to be set"
				);
			}
			const installed = await unwrap(() => driver.app.isInstalled(bundleId), `check ${bundleId}`, session.signal);
			if (installed) await unwrap(() => driver.app.uninstall(bundleId), `uninstall ${bundleId}`, session.signal);
			await unwrap(() => driver.app.install(path), `install ${path}`, session.signal);
		},
		async clearData() {
			await unwrap(() => driver.app.clearData(bundleId, { keychain: true }), `clear data ${bundleId}`, session.signal);
		},
		isRunning() {
			return unwrap(() => driver.app.isRunning(bundleId), `check ${bundleId} running`, session.signal);
		},
	};
}
