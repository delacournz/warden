import type { DriverError, Logger } from "@delacour/warden-driver/driver.types";
import type { SimdSpawn } from "@delacour/warden-driver/helper/simd-transport";
import { spanDetails } from "@delacour/warden-driver/trace/span-detail";
import type { AdbSession } from "./adb-session";
import type { Clock } from "./android-device";
import { type UiadClient, uiadClients } from "./uiad-client";
import { type PushDex, type UiadDevice, uiadDevice } from "./uiad-device";

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
	/** `uiadDevice.launchUiad` (tests replace it) */
	launch?: UiadDevice["launchUiad"];
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

/** Environment switches and failure classification for the resident server. */
export class UiadBackendRules {
	/** What a caller puts in `AndroidDriverOptions.uiad` for the environment it runs in: the server unless it is switched off. */
	uiadFromEnv(env: Readonly<Record<string, string | undefined>>): true | undefined {
		return env[UIAD_ENV] === "0" ? undefined : true;
	}

	/**
	 * A start failure that retrying will not fix: the hidden API is missing, or the server cannot even load. An
	 * `E_UNSUPPORTED` is written down at once; a `connect_failed` only when {@link CONNECT_FAILURES_TO_PERSIST} starts in a
	 * row end with it, since the server cannot yet tell a missing API from a transient connect error.
	 */
	isPersistentStartFailure(error: DriverError): boolean {
		const detail: unknown = error.detail;
		const reason =
			typeof detail === "object" && detail !== null && "reason" in detail
				? (detail as { reason: unknown }).reason
				: undefined;
		return error.code === "E_UNSUPPORTED" || reason === "connect_failed";
	}
}

export const uiadBackendRules = new UiadBackendRules();

/** The driver's hold on one device's `warden-uiad`: lazy single-flight start, restarts and give-up rules. */
export class UiadBackendService implements UiadBackend {
	private off: string | undefined;
	private current: UiadClient | undefined;
	private starting: Promise<UiadClient | undefined> | undefined;
	private started = 0;
	private startFailures = 0;
	/** starts in a row that failed with `connect_failed` */
	private connectFailures = 0;
	private busy: { error: DriverError; at: number } | undefined;
	private readonly launch: UiadDevice["launchUiad"];

	constructor(private readonly deps: UiadBackendDeps) {
		this.launch = deps.launch ?? ((launchDeps) => uiadDevice.launchUiad(launchDeps));
		this.off =
			deps.unsupportedBuild === uiadDevice.uiadBuildId() ? "this build does not run on this device" : undefined;
	}

	wanted(): boolean {
		return this.off === undefined;
	}

	blocked(): DriverError | undefined {
		return this.busy?.error;
	}

	status(): string {
		if (this.off !== undefined) return `off: ${this.off}`;
		if (this.busy !== undefined) return "busy";
		return this.current?.alive() ? "up" : "idle";
	}

	async server(): Promise<UiadClient | undefined> {
		if (this.off !== undefined) return undefined;
		if (this.current?.alive()) return this.current;
		if (this.busy !== undefined && this.deps.clock.now() - this.busy.at < BUSY_BACKOFF_MS) return undefined;
		this.starting ??= this.start().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	async failed(error: DriverError): Promise<void> {
		this.deps.log?.(`uiad: ${error.code}: ${error.message}`);
		const dead = this.current;
		this.current = undefined;
		await dead?.close();
	}

	async stop(): Promise<void> {
		const live = this.current;
		this.current = undefined;
		await this.starting?.catch(() => undefined);
		const late = this.current as UiadClient | undefined;
		this.current = undefined;
		await Promise.all([live?.close(), late?.close()]);
	}

	private giveUp(why: string): void {
		this.off = why;
		this.deps.log?.(`uiad: off for this driver (${why}); using uiautomator dump and input`);
	}

	private async start(): Promise<UiadClient | undefined> {
		const { deps } = this;
		if (this.started > MAX_RESTARTS) {
			this.giveUp(`it died ${this.started} times`);
			return undefined;
		}
		const startedAt = Date.now();
		const launched = await this.launch({
			session: deps.session,
			adb: deps.adb,
			serial: deps.serial,
			...(deps.log ? { log: deps.log } : {}),
			...(deps.options.spawn ? { spawn: deps.options.spawn } : {}),
			...(deps.options.push ? { push: deps.options.push } : {}),
			...(deps.options.readyTimeoutMs !== undefined ? { readyTimeoutMs: deps.options.readyTimeoutMs } : {}),
			...(deps.options.requestTimeoutMs !== undefined ? { requestTimeoutMs: deps.options.requestTimeoutMs } : {}),
			sleep: deps.clock.sleep,
		});
		spanDetails.add("uiadStartMs", Date.now() - startedAt);
		if (launched.success) {
			this.started++;
			this.startFailures = 0;
			this.connectFailures = 0;
			this.busy = undefined;
			this.current = launched.data;
			return this.current;
		}
		return this.failedStart(launched.error);
	}

	/** A start that failed: a busy slot is waited out; anything else counts against the server. */
	private failedStart(error: DriverError): undefined {
		const { log } = this.deps;
		if (uiadClients.isBusy(error)) {
			this.busy = { error, at: this.deps.clock.now() };
			this.connectFailures = 0;
			log?.(`uiad: ${error.message}`);
			return undefined;
		}
		log?.(`uiad: could not start (${error.code}: ${error.message})`);
		this.busy = undefined;
		this.startFailures++;
		this.connectFailures =
			error.code !== "E_UNSUPPORTED" && uiadBackendRules.isPersistentStartFailure(error) ? this.connectFailures + 1 : 0;
		if (error.code === "E_UNSUPPORTED" || this.connectFailures >= CONNECT_FAILURES_TO_PERSIST) {
			this.deps.onUnsupported?.(uiadDevice.uiadBuildId());
			this.giveUp(error.message);
		} else if (this.startFailures >= MAX_START_FAILURES) {
			this.giveUp(`${this.startFailures} starts failed in a row`);
		}
		return undefined;
	}
}
