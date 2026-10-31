import type { Driver, Element, LaunchOptions, Snapshot } from "./driver/driver.types";
import { canObserve } from "./driver/observation-cache";
import { DEFAULT_SETTLE_QUIET_MS, DEFAULT_SETTLE_TIMEOUT_MS } from "./driver/settle";
import { settled, toE2eError, unwrap } from "./driver/unwrap";
import type { E2eEnv } from "./env";
import { E2eError } from "./errors";
import { type Clock, type FixtureSession, systemClock } from "./fixture-session";
import { isLocator, type Locator } from "./screen/locator";
import { isInteractiveRole, resolveRole } from "./screen/roles";

/** `app.open({ wait: { until } })`: the first screen, named by a locator. */
export type OpenWaitUntil = {
	/** a locator made by `screen` that is visible once the app's first screen is up */
	until: Locator;
	/** how long `until` gets to show; default the assertion timeout (`WARDEN_E2E_ASSERTION_TIMEOUT`) */
	timeout?: number;
};

export type OpenOptions = {
	/** opened with `driver.app.openUrl` once the app is launched */
	url?: string;
	/** appended after `WARDEN_LAUNCH_ARGS` (on Android, which cannot take launch args, these still fail the launch) */
	args?: readonly string[];
	env?: Record<string, string>;
	/**
	 * `"none"` (default): return when the launch call returns, which is before the app is on screen.
	 *
	 * `"quiet"`: then wait for the first screen and for it to stop moving. A launch screen (a storyboard, an Android
	 * splash) is idle while the app loads, so "quiet" alone would end on it: the screen is read after 100, 200, then
	 * every 400 ms until it shows content (a visible control, or any element with a testID), for at most 3 s, then
	 * settled (what `device.settle()` waits for: 250 ms of quiet, at most 3 s). That is a best-effort wait, never an
	 * error: a first screen with no control and no testID waits out the 3 s, and an app that is not quiet in time is
	 * returned as it is, so assert on what the test needs.
	 *
	 * `{ until }`: wait for that locator to be visible (an error after `timeout`, like `toBeVisible()`), then settle
	 * once, so the next tap lands on a mounted screen. Use it in place of `open()` followed by `toBeVisible()`.
	 */
	wait?: "quiet" | "none" | OpenWaitUntil;
};

/**
 * The gaps between `wait: "quiet"`'s looks for the first screen; the last one repeats. Full dumps back to back would
 * compete with the cold start for CPU.
 */
const CONTENT_POLL_MS: readonly number[] = [100, 200, 400];

/**
 * Ids of Android's own window decor (`android:id/content`, the AppCompat action bar root, the system bar
 * backgrounds) and of the API 31+ splash screen's views (core-splashscreen's icon and branding), present on a splash
 * screen too, so they say nothing about the app's first screen.
 */
const DECOR_IDS: ReadonlySet<string> = new Set([
	"content",
	"action_bar_root",
	"action_bar_container",
	"action_bar",
	"decor_content_parent",
	"statusBarBackground",
	"navigationBarBackground",
	"splashscreen_view",
	"splashscreen_icon_view",
	"splashscreen_branding_view",
]);

/** A visible control or a visible element with a testID: what a launch screen has none of. */
function isContent(element: Element, parent: Element | undefined, platform: Snapshot["platform"]): boolean {
	if (element.hidden === true) return false;
	const id = element.identifier;
	if (id !== undefined && id !== "" && !(platform === "android" && DECOR_IDS.has(id))) return true;
	return isInteractiveRole(resolveRole(element, parent).role);
}

function hasContent(snapshot: Snapshot): boolean {
	const visit = (element: Element, parent: Element | undefined): boolean =>
		isContent(element, parent, snapshot.platform) || element.children.some((child) => visit(child, element));
	return snapshot.elements.some((element) => visit(element, undefined));
}

type ParsedWait = { kind: "none" } | { kind: "quiet" } | { kind: "until"; until: Locator; timeout?: number };

function parseWait(wait: OpenOptions["wait"]): ParsedWait {
	if (wait === undefined || wait === "none") return { kind: "none" };
	if (wait === "quiet") return { kind: "quiet" };
	if (typeof wait === "object" && wait !== null && isLocator(wait.until)) {
		const { timeout } = wait;
		if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)) {
			throw new E2eError("INVALID_ARGUMENT", `app.open wait timeout must be a non-negative number, got ${timeout}`);
		}
		return timeout === undefined ? { kind: "until", until: wait.until } : { kind: "until", until: wait.until, timeout };
	}
	throw new E2eError(
		"INVALID_ARGUMENT",
		`app.open wait must be "quiet", "none" or { until: <locator made by screen> }, got ${describeWait(wait)}`
	);
}

function describeWait(wait: unknown): string {
	if (typeof wait === "string") return JSON.stringify(wait);
	if (wait === null || typeof wait !== "object") return String(wait);
	return `{ ${Object.keys(wait).join(", ")} }`;
}

/** The app under test (`WARDEN_BUNDLE_ID`). */
/** expo-dev-launcher's own flags (read off the deep link): no first-run onboarding sheet, no menu at launch, no floating button, as iOS's `DEV_MENU_OFF_ARGS` do */
const DEV_CLIENT_QUIET = "disableOnboarding=1&disableAutoLaunch=1&disableFab=1";

export type App = {
	/**
	 * Launches the app (terminating a running instance first) with `WARDEN_LAUNCH_ARGS` + `args`, then
	 * opens `url` if given, then waits as `wait` says (`"quiet"`: first content then still; `{ until }`). The runner calls this (with no options) for the per-test
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
	/** time for the `wait: "quiet"` content poll; default the system clock */
	clock?: Clock;
	/** whether an iOS launch loads the warden network dylib (the suite declares a network or clock condition, or one is active) */
	injectWanted?: () => boolean;
};

const stderrLog = (line: string): void => {
	process.stderr.write(`${line}\n`);
};

export function createApp({ session, driver, env, log = stderrLog, clock = systemClock, injectWanted }: AppDeps): App {
	const bundleId = env.bundleId;
	let droppedLogged = false;
	/**
	 * Metro's `--initialUrl <url>` from `WARDEN_LAUNCH_ARGS`, as the dev-client deep link an Android launch opens after it
	 * starts (Android launches take no args). Needs `WARDEN_DEV_CLIENT_SCHEME`.
	 */
	const devClientLink = (): string | undefined => {
		if (driver.platform !== "android" || env.devClientScheme === undefined) return undefined;
		const at = env.launchArgs.indexOf("--initialUrl");
		const metro = at < 0 ? undefined : env.launchArgs[at + 1];
		return metro === undefined
			? undefined
			: `${env.devClientScheme}://expo-development-client/?url=${encodeURIComponent(metro)}&${DEV_CLIENT_QUIET}`;
	};
	/**
	 * `WARDEN_LAUNCH_ARGS` as this platform can take them. Android launches have no args (Metro's `--initialUrl` is
	 * opened as a dev-client deep link instead, see `devClientLink`), so the env's args are dropped there, with one
	 * log line; explicit `open({ args })` are kept so they still fail loudly.
	 */
	const envLaunchArgs = (): readonly string[] => {
		if (driver.platform !== "android" || env.launchArgs.length === 0) return env.launchArgs;
		if (!droppedLogged && devClientLink() === undefined) {
			droppedLogged = true;
			log(`[warden-e2e] Android launch takes no args: ignoring WARDEN_LAUNCH_ARGS ${JSON.stringify(env.launchArgs)}`);
		}
		return [];
	};
	/** One fresh look at the whole screen (never a kept snapshot); undefined when the read failed (the app is starting). */
	const look = async (): Promise<Snapshot | undefined> => {
		const read = await settled(
			() => (canObserve(driver) ? driver.observe({ reuse: false }) : driver.snapshot()),
			`read ${bundleId}`,
			session.signal
		);
		return read.success ? read.data : undefined;
	};

	/** Polls until the screen has content (see `OpenOptions.wait`), at most `DEFAULT_SETTLE_TIMEOUT_MS`; never an error. */
	const waitForContent = async (): Promise<void> => {
		const deadline = clock.now() + DEFAULT_SETTLE_TIMEOUT_MS;
		for (let poll = 0; ; poll++) {
			const snapshot = await look();
			if (snapshot !== undefined && hasContent(snapshot)) return;
			const left = deadline - clock.now();
			if (left <= 0) return;
			const gap = CONTENT_POLL_MS[Math.min(poll, CONTENT_POLL_MS.length - 1)] ?? 100;
			await clock.sleep(Math.min(gap, left));
		}
	};

	/**
	 * One `settle` (250 ms of quiet, at most 3 s); a driver that cannot settle is left alone, as `device.settle()`
	 * would poll instead. iOS: after a launch that rebound the helper the app is in front already.
	 */
	const waitUntilQuiet = async (): Promise<void> => {
		const quiet = await settled(
			() => driver.settle({ quietMs: DEFAULT_SETTLE_QUIET_MS, timeoutMs: DEFAULT_SETTLE_TIMEOUT_MS }),
			`wait for ${bundleId}`,
			session.signal
		);
		if (!quiet.success && quiet.error.code !== "E_UNSUPPORTED") throw toE2eError(quiet.error, `wait for ${bundleId}`);
	};

	/** after the launch: Android points the dev client at Metro, a dev client gets devtools attached, then the caller's `url` opens */
	const afterLaunch = async (url: string | undefined): Promise<void> => {
		const link = devClientLink();
		if (link !== undefined) await unwrap(() => driver.app.openUrl(link), `open dev client ${link}`, session.signal);
		// a dev client: attach devtools in the background, which keeps LogBox off in every JS context from now on
		if (env.metroUrl !== undefined) void session.devtools?.();
		if (url !== undefined) await unwrap(() => driver.app.openUrl(url), `open ${url}`, session.signal);
	};

	const launch = async (options: OpenOptions = {}): Promise<void> => {
		const wait = parseWait(options.wait);
		const opts: LaunchOptions = {
			args: [...envLaunchArgs(), ...(options.args ?? [])],
			relaunch: true,
		};
		if (options.env !== undefined) opts.env = options.env;
		if (driver.platform === "ios" && injectWanted?.() === true) opts.inject = true;
		await unwrap(() => driver.app.launch(bundleId, opts), `launch ${bundleId}`, session.signal);
		await afterLaunch(options.url);
		if (wait.kind === "quiet") {
			await waitForContent();
			await waitUntilQuiet();
		}
		if (wait.kind === "until") {
			await wait.until.waitFor({ state: "visible", timeout: wait.timeout ?? env.assertionTimeoutMs });
			await waitUntilQuiet();
		}
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
