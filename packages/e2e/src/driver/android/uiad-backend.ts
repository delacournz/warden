import type { DriverError, Logger } from "../driver.types";
import type { SimdSpawn } from "../ios/simd-transport";
import { addSpanDetail } from "../span-detail";
import type { AdbSession } from "./adb-session";
import type { Clock } from "./android-device";
import { isBusy, type UiadClient } from "./uiad-client";
import { launchUiad, type PushDex, uiadBuildId } from "./uiad-device";

/**
 * The driver's hold on `warden-uiad`: started when the first call that can use it arrives (a spec that only opens
 * links never pays for it), reused for every call after, and given up on, for this driver, when it cannot be made to
 * work. "Given up" means the driver goes on with `uiautomator dump` and `input`: the server is an accelerator, never a
 * requirement. The one failure that is not answered with a fallback is a busy UiAutomation slot, because the dump needs
 * the same slot and would die with a bare "Killed": that is reported as what it is.
 */

/** Seams and switches for the resident server, from `AndroidDriverOptions.uiad`. */
export type UiadOptions = {
	/** how the server's `adb shell` is spawned (tests); default a real `adb` child */
	spawn?: SimdSpawn;
	/** how the dex is written to the device (tests); default `adb shell cat > file` with the bytes on stdin */
	push?: PushDex;
	/** how long to wait for the server's `ready`, default 5 s */
	readyTimeoutMs?: number;
	/** how long a request may take before the server is judged hung, default 10 s */
	requestTimeoutMs?: number;
};

export type UiadBackend = {
	/** the server is switched on and has not been given up on */
	wanted(): boolean;
	/** the running server, started if need be; undefined means "use the dump and `input`" for this call */
	server(): Promise<UiadClient | undefined>;
	/** why UiAutomation is unavailable when something else holds it (the dump would fail the same way) */
	blocked(): DriverError | undefined;
	/** a call to the server failed: stop it so the dump can run; it is started again by the next `server()` unless it keeps failing */
	failed(error: DriverError): Promise<void>;
	/** stop the server, if there is one */
	stop(): Promise<void>;
	/** for `health`: "up", "idle", or why it is off */
	status(): string;
};

export type UiadBackendDeps = {
	session: AdbSession;
	adb: string;
	serial: string;
	clock: Clock;
	log?: Logger;
	options: UiadOptions;
	/** a build that this device is known not to run: the server is off from the start */
	unsupportedBuild?: string;
	/** told when a start failed for a reason that will not change, so the next process need not try */
	onUnsupported?: (buildId: string) => void;
	/** `launchUiad` (tests replace it) */
	launch?: typeof launchUiad;
};

/** How many times a server may be started again after it died, and how many starts in a row may fail, before giving up. */
const MAX_RESTARTS = 3;
const MAX_START_FAILURES = 2;
/**
 * How many starts in a row must fail to connect UiAutomation (`connect_failed`) before that is written down. One can be
 * a `system_server` hiccup (an emulator that has just booted, a loaded host), so it is only one failed start.
 */
const CONNECT_FAILURES_TO_PERSIST = 2;
/** After a busy slot, how long before asking again (a polling loop must not start a server on every tick). */
const BUSY_BACKOFF_MS = 2_000;

/** `WARDEN_ANDROID_UIAD=0` keeps the driver on `uiautomator dump` and `input` (the server is on otherwise). */
export const UIAD_ENV = "WARDEN_ANDROID_UIAD";

/** What a caller puts in `AndroidDriverOptions.uiad` for the environment it runs in: the server unless it is switched off. */
export function uiadFromEnv(env: Readonly<Record<string, string | undefined>>): true | undefined {
	return env[UIAD_ENV] === "0" ? undefined : true;
}

/**
 * A start failure that retrying will not fix: the hidden API is missing, or the server cannot even load. An
 * `E_UNSUPPORTED` is written down at once; a `connect_failed` only when {@link CONNECT_FAILURES_TO_PERSIST} starts in a
 * row end with it, since the server cannot yet tell a missing API from a transient connect error.
 */
export function isPersistentStartFailure(error: DriverError): boolean {
	const detail: unknown = error.detail;
	const reason =
		typeof detail === "object" && detail !== null && "reason" in detail
			? (detail as { reason: unknown }).reason
			: undefined;
	return error.code === "E_UNSUPPORTED" || reason === "connect_failed";
}

export function createUiadBackend(deps: UiadBackendDeps): UiadBackend {
	const { log, clock } = deps;
	const launch = deps.launch ?? launchUiad;
	let off: string | undefined =
		deps.unsupportedBuild === uiadBuildId() ? "this build does not run on this device" : undefined;
	let current: UiadClient | undefined;
	let starting: Promise<UiadClient | undefined> | undefined;
	let started = 0;
	let startFailures = 0;
	/** starts in a row that failed with `connect_failed` */
	let connectFailures = 0;
	let busy: { error: DriverError; at: number } | undefined;

	const giveUp = (why: string): void => {
		off = why;
		log?.(`uiad: off for this driver (${why}); using uiautomator dump and input`);
	};

	async function start(): Promise<UiadClient | undefined> {
		if (started > MAX_RESTARTS) {
			giveUp(`it died ${started} times`);
			return undefined;
		}
		const startedAt = Date.now();
		const launched = await launch({
			session: deps.session,
			adb: deps.adb,
			serial: deps.serial,
			...(log ? { log } : {}),
			...(deps.options.spawn ? { spawn: deps.options.spawn } : {}),
			...(deps.options.push ? { push: deps.options.push } : {}),
			...(deps.options.readyTimeoutMs !== undefined ? { readyTimeoutMs: deps.options.readyTimeoutMs } : {}),
			...(deps.options.requestTimeoutMs !== undefined ? { requestTimeoutMs: deps.options.requestTimeoutMs } : {}),
			sleep: clock.sleep,
		});
		addSpanDetail("uiadStartMs", Date.now() - startedAt);
		if (launched.success) {
			started++;
			startFailures = 0;
			connectFailures = 0;
			busy = undefined;
			current = launched.data;
			return current;
		}
		return failedStart(launched.error);
	}

	/** A start that failed: a busy slot is waited out; anything else counts against the server. */
	function failedStart(error: DriverError): undefined {
		if (isBusy(error)) {
			busy = { error, at: clock.now() };
			connectFailures = 0;
			log?.(`uiad: ${error.message}`);
			return undefined;
		}
		log?.(`uiad: could not start (${error.code}: ${error.message})`);
		busy = undefined;
		startFailures++;
		connectFailures = error.code !== "E_UNSUPPORTED" && isPersistentStartFailure(error) ? connectFailures + 1 : 0;
		if (error.code === "E_UNSUPPORTED" || connectFailures >= CONNECT_FAILURES_TO_PERSIST) {
			deps.onUnsupported?.(uiadBuildId());
			giveUp(error.message);
		} else if (startFailures >= MAX_START_FAILURES) {
			giveUp(`${startFailures} starts failed in a row`);
		}
		return undefined;
	}

	return {
		wanted: () => off === undefined,
		blocked: () => busy?.error,
		status() {
			if (off !== undefined) return `off: ${off}`;
			if (busy !== undefined) return "busy";
			return current?.alive() ? "up" : "idle";
		},
		async server() {
			if (off !== undefined) return undefined;
			if (current?.alive()) return current;
			if (busy !== undefined && clock.now() - busy.at < BUSY_BACKOFF_MS) return undefined;
			starting ??= start().finally(() => {
				starting = undefined;
			});
			return starting;
		},
		async failed(error) {
			log?.(`uiad: ${error.code}: ${error.message}`);
			const dead = current;
			current = undefined;
			await dead?.close();
		},
		async stop() {
			const live = current;
			current = undefined;
			await starting?.catch(() => undefined);
			const late = current as UiadClient | undefined;
			current = undefined;
			await Promise.all([live?.close(), late?.close()]);
		},
	};
}
