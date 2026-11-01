import type { Driver, Element, LaunchOptions, Snapshot } from "@delacour/warden-driver/driver.types";
import { E2eError } from "@delacour/warden-driver/e2e-error";
import { observations } from "@delacour/warden-driver/observation-cache";
import { DEFAULT_SETTLE_QUIET_MS, DEFAULT_SETTLE_TIMEOUT_MS } from "@delacour/warden-driver/settle";
import { driverCalls } from "@delacour/warden-driver/unwrap";
import { type Locator, locatorSupport } from "@delacour/warden-screen/locator";
import { roleResolver } from "@delacour/warden-screen/roles";
import { type Clock, systemClock } from "./fixture-session";

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

type ParsedWait = { kind: "none" } | { kind: "quiet" } | { kind: "until"; until: Locator; timeout?: number };

/** Reads what a launched app's first screen shows and what `app.open({ wait })` asks for. */
class OpenScreens {
	/** A visible control or a visible element with a testID: what a launch screen has none of. */
	hasContent(snapshot: Snapshot): boolean {
		const visit = (element: Element, parent: Element | undefined): boolean =>
			this.isContent(element, parent, snapshot.platform) || element.children.some((child) => visit(child, element));
		return snapshot.elements.some((element) => visit(element, undefined));
	}

	parseWait(wait: OpenOptions["wait"]): ParsedWait {
		if (wait === undefined || wait === "none") return { kind: "none" };
		if (wait === "quiet") return { kind: "quiet" };
		if (typeof wait === "object" && wait !== null && locatorSupport.isLocator(wait.until)) {
			const { timeout } = wait;
			if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)) {
				throw new E2eError("INVALID_ARGUMENT", `app.open wait timeout must be a non-negative number, got ${timeout}`);
			}
			return timeout === undefined
				? { kind: "until", until: wait.until }
				: { kind: "until", until: wait.until, timeout };
		}
		throw new E2eError(
			"INVALID_ARGUMENT",
			`app.open wait must be "quiet", "none" or { until: <locator made by screen> }, got ${this.describeWait(wait)}`
		);
	}

	private isContent(element: Element, parent: Element | undefined, platform: Snapshot["platform"]): boolean {
		if (element.hidden === true) return false;
		const id = element.identifier;
		if (id !== undefined && id !== "" && !(platform === "android" && DECOR_IDS.has(id))) return true;
		return roleResolver.isInteractiveRole(roleResolver.resolveRole(element, parent).role);
	}

	private describeWait(wait: unknown): string {
		if (typeof wait === "string") return JSON.stringify(wait);
		if (wait === null || typeof wait !== "object") return String(wait);
		return `{ ${Object.keys(wait).join(", ")} }`;
	}
}

const openScreens = new OpenScreens();

/** The app under test (`WARDEN_BUNDLE_ID`). */
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

/** What an `app` needs, as values: no env, no runner session (`fixtures.ts` adapts the session). */
export type AppDeps = {
	driver: Driver;
	/** the app under test: its bundle id (iOS) or package (Android) */
	appId: string;
	/** the build `app.reinstall()` installs (`WARDEN_APP_PATH`); without it `reinstall()` throws `INVALID_ARGUMENT` */
	appPath?: string;
	/** args every launch gets (`WARDEN_LAUNCH_ARGS`); dropped on Android */
	launchArgs?: readonly string[];
	/** the wait for `open({ wait: { until } })` when it names no timeout */
	assertionTimeoutMs?: number;
	/** the running attempt's deadline: every driver call honours it; read per call */
	signal?: () => AbortSignal | undefined;
	/** where the one "dropped WARDEN_LAUNCH_ARGS on Android" line goes; default stderr */
	log?: (line: string) => void;
	/** time for the `wait: "quiet"` content poll; default the system clock */
	clock?: Clock;
	/** whether an iOS launch loads the warden network dylib (the suite declares a network or clock condition, or one is active) */
	injectWanted?: () => boolean;
	/** called after every launch (a dev client attaches devtools in the background there, which keeps LogBox off in every JS context from then on) */
	onLaunched?: () => void;
};

/** The {@link App} over a {@link Driver}. */
export class AppController implements App {
	private readonly stderrLog = (line: string): void => {
		process.stderr.write(`${line}\n`);
	};

	private readonly bundleId: string;
	private readonly launchArgs: readonly string[];
	private readonly log: (line: string) => void;
	private readonly clock: Clock;
	private droppedLogged = false;

	constructor(private readonly deps: AppDeps) {
		this.bundleId = deps.appId;
		this.launchArgs = deps.launchArgs ?? [];
		this.log = deps.log ?? this.stderrLog;
		this.clock = deps.clock ?? systemClock;
	}

	readonly open = async (options: OpenOptions = {}): Promise<void> => {
		const { driver, assertionTimeoutMs, injectWanted, onLaunched } = this.deps;
		const wait = openScreens.parseWait(options.wait);
		const opts: LaunchOptions = {
			args: [...this.envLaunchArgs(), ...(options.args ?? [])],
			relaunch: true,
		};
		if (options.env !== undefined) opts.env = options.env;
		if (driver.platform === "ios" && injectWanted?.() === true) opts.inject = true;
		await driverCalls.unwrap(() => driver.app.launch(this.bundleId, opts), `launch ${this.bundleId}`, this.signal());
		onLaunched?.();
		if (options.url !== undefined) {
			const url = options.url;
			await driverCalls.unwrap(() => driver.app.openUrl(url), `open ${url}`, this.signal());
		}
		if (wait.kind === "quiet") {
			await this.waitForContent();
			await this.waitUntilQuiet();
		}
		if (wait.kind === "until") {
			await wait.until.waitFor({ state: "visible", timeout: wait.timeout ?? assertionTimeoutMs });
			await this.waitUntilQuiet();
		}
	};

	readonly close = (): Promise<void> =>
		driverCalls.unwrap(
			() => this.deps.driver.app.terminate(this.bundleId),
			`terminate ${this.bundleId}`,
			this.signal()
		);

	readonly restart = async (): Promise<void> => {
		await this.open();
	};

	readonly reinstall = async (): Promise<void> => {
		const { driver, appPath } = this.deps;
		const bundleId = this.bundleId;
		const path = appPath;
		if (path === undefined) {
			throw new E2eError("INVALID_ARGUMENT", "app.reinstall() needs WARDEN_APP_PATH (the build to install) to be set");
		}
		const installed = await driverCalls.unwrap(
			() => driver.app.isInstalled(bundleId),
			`check ${bundleId}`,
			this.signal()
		);
		if (installed)
			await driverCalls.unwrap(() => driver.app.uninstall(bundleId), `uninstall ${bundleId}`, this.signal());
		await driverCalls.unwrap(() => driver.app.install(path), `install ${path}`, this.signal());
	};

	readonly clearData = async (): Promise<void> => {
		const bundleId = this.bundleId;
		await driverCalls.unwrap(
			() => this.deps.driver.app.clearData(bundleId, { keychain: true }),
			`clear data ${bundleId}`,
			this.signal()
		);
	};

	readonly isRunning = (): Promise<boolean> =>
		driverCalls.unwrap(
			() => this.deps.driver.app.isRunning(this.bundleId),
			`check ${this.bundleId} running`,
			this.signal()
		);

	private signal(): AbortSignal | undefined {
		return this.deps.signal?.();
	}

	/**
	 * `WARDEN_LAUNCH_ARGS` as this platform can take them. Android launches have no args (the dev client reaches Metro
	 * through `adb reverse` and its default url), so the env's args (Metro's `--initialUrl`, `spec.launchArgs`) are
	 * dropped there, with one log line; explicit `open({ args })` are kept so they still fail loudly.
	 */
	private envLaunchArgs(): readonly string[] {
		if (this.deps.driver.platform !== "android" || this.launchArgs.length === 0) return this.launchArgs;
		if (!this.droppedLogged) {
			this.droppedLogged = true;
			this.log(
				`[warden-e2e] Android launch takes no args: ignoring WARDEN_LAUNCH_ARGS ${JSON.stringify(this.launchArgs)}`
			);
		}
		return [];
	}

	/** One fresh look at the whole screen (never a kept snapshot); undefined when the read failed (the app is starting). */
	private async look(): Promise<Snapshot | undefined> {
		const { driver } = this.deps;
		const read = await driverCalls.settled(
			() => (observations.canObserve(driver) ? driver.observe({ reuse: false }) : driver.snapshot()),
			`read ${this.bundleId}`,
			this.signal()
		);
		return read.success ? read.data : undefined;
	}

	/** Polls until the screen has content (see `OpenOptions.wait`), at most `DEFAULT_SETTLE_TIMEOUT_MS`; never an error. */
	private async waitForContent(): Promise<void> {
		const deadline = this.clock.now() + DEFAULT_SETTLE_TIMEOUT_MS;
		for (let poll = 0; ; poll++) {
			const snapshot = await this.look();
			if (snapshot !== undefined && openScreens.hasContent(snapshot)) return;
			const left = deadline - this.clock.now();
			if (left <= 0) return;
			const gap = CONTENT_POLL_MS[Math.min(poll, CONTENT_POLL_MS.length - 1)] ?? 100;
			await this.clock.sleep(Math.min(gap, left));
		}
	}

	/**
	 * One `settle` (250 ms of quiet, at most 3 s); a driver that cannot settle is left alone, as `device.settle()`
	 * would poll instead. iOS: after a launch that rebound the helper the app is in front already.
	 */
	private async waitUntilQuiet(): Promise<void> {
		const { driver } = this.deps;
		const quiet = await driverCalls.settled(
			() => driver.settle({ quietMs: DEFAULT_SETTLE_QUIET_MS, timeoutMs: DEFAULT_SETTLE_TIMEOUT_MS }),
			`wait for ${this.bundleId}`,
			this.signal()
		);
		if (!quiet.success && quiet.error.code !== "E_UNSUPPORTED")
			throw driverCalls.toE2eError(quiet.error, `wait for ${this.bundleId}`);
	}
}
