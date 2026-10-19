import type { Driver, LaunchOptions } from "./driver/driver.types";
import { DEFAULT_SETTLE_QUIET_MS, DEFAULT_SETTLE_TIMEOUT_MS } from "./driver/settle";
import { settled, toE2eError, unwrap } from "./driver/unwrap";
import type { E2eEnv } from "./env";
import { E2eError } from "./errors";
import type { FixtureSession } from "./fixture-session";

export type OpenOptions = {
	/** opened with `driver.app.openUrl` once the app is launched */
	url?: string;
	/** appended after `WARDEN_LAUNCH_ARGS` (on Android, which cannot take launch args, these still fail the launch) */
	args?: readonly string[];
	env?: Record<string, string>;
	/**
	 * `"none"` (default): return when the launch call returns, which is before the app is on screen. `"quiet"`: then
	 * also wait for the app to be frontmost and the screen to stop moving (what `device.settle()` waits for, 250 ms of
	 * quiet, at most 3 s). That is a best-effort wait, never an error: an app that is not quiet in time is returned as
	 * it is, so assert on what the test needs.
	 */
	wait?: "quiet" | "none";
};

const WAITS: readonly string[] = ["quiet", "none"];

/** The app under test (`WARDEN_BUNDLE_ID`). */
export type App = {
	/**
	 * Launches the app (terminating a running instance first) with `WARDEN_LAUNCH_ARGS` + `args`, then
	 * opens `url` if given, then waits when `wait: "quiet"`. The runner calls this (with no options) for the per-test
	 * `launch: "fresh"` default.
	 */
	open(options?: OpenOptions): Promise<void>;
	close(): Promise<void>;
	/** terminate, then launch again with `WARDEN_LAUNCH_ARGS` (the launch itself terminates a running instance, so there is one stop, not two) */
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
	/** where the one "dropped WARDEN_LAUNCH_ARGS on Android" line goes; default stderr */
	log?: (line: string) => void;
};

const stderrLog = (line: string): void => {
	process.stderr.write(`${line}\n`);
};

export function createApp({ session, driver, env, log = stderrLog }: AppDeps): App {
	const bundleId = env.bundleId;
	let droppedLogged = false;
	/**
	 * `WARDEN_LAUNCH_ARGS` as this platform can take them. Android launches have no args (the dev client reaches Metro
	 * through `adb reverse` and its default url), so the env's args (Metro's `--initialUrl`, `spec.launchArgs`) are
	 * dropped there, with one log line; explicit `open({ args })` are kept so they still fail loudly.
	 */
	const envLaunchArgs = (): readonly string[] => {
		if (driver.platform !== "android" || env.launchArgs.length === 0) return env.launchArgs;
		if (!droppedLogged) {
			droppedLogged = true;
			log(`[warden-e2e] Android launch takes no args: ignoring WARDEN_LAUNCH_ARGS ${JSON.stringify(env.launchArgs)}`);
		}
		return [];
	};
	/**
	 * One `settle`. iOS names the bundle `app.launch` started (the helper holds "quiet" back until that app is in front);
	 * a driver that cannot settle is left alone, as `device.settle()` would poll instead.
	 */
	const waitUntilQuiet = async (): Promise<void> => {
		const quiet = await settled(
			() => driver.settle({ quietMs: DEFAULT_SETTLE_QUIET_MS, timeoutMs: DEFAULT_SETTLE_TIMEOUT_MS }),
			`wait for ${bundleId}`,
			session.signal
		);
		if (!quiet.success && quiet.error.code !== "E_UNSUPPORTED") throw toE2eError(quiet.error, `wait for ${bundleId}`);
	};

	const launch = async (options: OpenOptions = {}): Promise<void> => {
		const wait = options.wait ?? "none";
		if (!WAITS.includes(wait)) {
			throw new E2eError("INVALID_ARGUMENT", `app.open wait must be "quiet" or "none", got ${JSON.stringify(wait)}`);
		}
		const opts: LaunchOptions = {
			args: [...envLaunchArgs(), ...(options.args ?? [])],
			relaunch: true,
		};
		if (options.env !== undefined) opts.env = options.env;
		await unwrap(() => driver.app.launch(bundleId, opts), `launch ${bundleId}`, session.signal);
		if (options.url !== undefined) {
			const url = options.url;
			await unwrap(() => driver.app.openUrl(url), `open ${url}`, session.signal);
		}
		if (wait === "quiet") await waitUntilQuiet();
	};

	const terminate = (): Promise<void> =>
		unwrap(() => driver.app.terminate(bundleId), `terminate ${bundleId}`, session.signal);

	return {
		open: launch,
		close: terminate,
		async restart() {
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
