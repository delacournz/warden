import type { ClockCondition, HostFault, NetworkCondition } from "@delacour/warden-config/conditions.types";
import { networkPresets } from "@delacour/warden-config/network.presets";
import type {
	ClockState,
	DriverError,
	DriverResult,
	LaunchOptions,
	NetworkOptions,
	NetworkState,
} from "@delacour/warden-driver/driver.types";
import { driverErrors } from "@delacour/warden-driver/errors";
import { type NetworkProxyPort, networkProxyShaping } from "@delacour/warden-driver/network-proxy";
import type { Result } from "@delacour/warden-types/result";
import { type InjectChannel, injectProtocol } from "./inject";

/**
 * iOS simulator network conditions: a simulator shares the host network, so nothing can shape one device. Instead
 * the app is launched with `libwarden-inject.dylib` (see `inject.ts`), which routes its NSURLSession traffic
 * through the lease's shaping proxy; the proxy does latency / bandwidth / loss / faults, and an `offline` flag in
 * the dylib's state file makes the app's own reachability APIs say so. Presets and offline switch live over the
 * proxy's control channel and the state file. Only the first enable needs a launch that carries the dylib.
 */

/** How long the injected app gets to acknowledge a state write (the dylib applies it on a dispatch source). */
export const INJECT_ACK_MS = 3_000;
/** How long a fresh launch gets to load the dylib and acknowledge its first state. */
export const INJECT_LOAD_MS = 8_000;

export type IosNetworkDeps = {
	proxy: NetworkProxyPort;
	channel: InjectChannel;
	/** the dylib path, resolved on first use so a run without conditions never looks for it */
	dylib: () => Result<string, DriverError>;
	/** is `bundleId` running now */
	isRunning: (bundleId: string) => DriverResult<boolean>;
	/** the last app this driver launched */
	lastBundle: () => string | undefined;
	/** launch `bundleId` again with the dylib (late-bound: the driver's own `app.launch`) */
	relaunch: (bundleId: string) => DriverResult<void>;
	debug?: boolean;
	/** wall time, ms (default `Date.now`); `fixed` clocks are an offset from it */
	now?: () => number;
};

export type IosNetwork = {
	network(op: NetworkCondition, opts?: NetworkOptions): DriverResult<NetworkState>;
	networkFaults(faults: readonly HostFault[]): DriverResult<{ notes: readonly string[] }>;
	/** Env to merge into a launch (`undefined`: launch plainly). Stages the state file the dylib reads at load. */
	launchEnv(opts: LaunchOptions): DriverResult<Record<string, string> | undefined>;
	/** After a launch that carried the dylib: wait until it loaded, so a missing injection fails here, not as a test that sees the wrong network. */
	confirmLoaded(): DriverResult<void>;
	/** Wall-clock offset for the injected app (COND-12). Live when the app is injected, else staged for the next launch. */
	setClockOffset(ms: number): DriverResult<void>;
	/** Mock the injected app's wall clock (`Driver.clock`). Live when the app is injected, else staged for the next launch. */
	clock(op: ClockCondition, opts?: NetworkOptions): DriverResult<ClockState>;
};

const okVoid = { success: true as const, data: undefined };

/** The shaping proxy and the inject state file behind one iOS simulator's network and clock conditions. */
export class IosNetworkController implements IosNetwork {
	private readonly proxy: NetworkProxyPort;
	private readonly channel: InjectChannel;
	private readonly now: () => number;
	private condition: NetworkCondition = { kind: "online" };
	private faults: readonly HostFault[] = [];
	private clockOffsetMs: number;
	private clockFrozenMs: number | undefined;
	private expectLoad = false;

	constructor(private readonly deps: IosNetworkDeps) {
		this.proxy = deps.proxy;
		this.channel = deps.channel;
		this.now = deps.now ?? Date.now;
		this.clockOffsetMs = this.channel.current().clockOffsetMs ?? 0;
		this.clockFrozenMs = this.channel.current().clockFrozenMs;
	}

	async network(op: NetworkCondition, opts?: NetworkOptions): DriverResult<NetworkState> {
		if (op.kind === "flap") {
			return driverErrors.err(
				"E_UNSUPPORTED",
				"flap is run by the condition scheduler (COND-6) as online/offline transitions"
			);
		}
		const previous = this.condition;
		this.condition = op;
		const applied = await this.apply(opts);
		if (!applied.success) {
			if (applied.error.code !== "E_NETWORK_RELAUNCH") this.condition = previous;
			return applied;
		}
		const plan = networkPresets.resolveNetwork(op);
		return {
			success: true,
			data: {
				online: plan.online,
				condition: op,
				needsProxy: [],
				...(applied.data || !this.routing() ? {} : { appliesOnLaunch: true as const }),
			},
		};
	}

	async networkFaults(next: readonly HostFault[]): DriverResult<{ notes: readonly string[] }> {
		const previous = this.faults;
		this.faults = next;
		const applied = await this.apply(undefined);
		if (!applied.success) {
			if (applied.error.code !== "E_NETWORK_RELAUNCH") this.faults = previous;
			return applied;
		}
		return { success: true, data: { notes: networkProxyShaping.faultNotes(next) } };
	}

	async launchEnv(opts: LaunchOptions): DriverResult<Record<string, string> | undefined> {
		const live = await this.proxy.current();
		if (
			!injectProtocol.shouldInject({
				networkActive: live !== undefined,
				clockActive: this.clockActive(),
				requested: opts.inject === true,
			})
		) {
			// a plain launch has no dylib: forget the ack of an earlier app so `attached()` never reports a ghost
			this.channel.reset();
			return { success: true, data: undefined };
		}
		const dylib = this.deps.dylib();
		if (!dylib.success) return dylib;
		let address = live;
		if (!address && (this.routing() || opts.inject === true)) {
			const started = await this.proxy.ensure(
				this.condition,
				networkProxyShaping.conditionsFor(this.condition, this.faults)
			);
			if (!started.success) return driverErrors.err("E_IO", started.error);
			address = started.data;
		}
		this.channel.reset();
		this.writeState();
		this.expectLoad = true;
		return {
			success: true,
			data: injectProtocol.launchEnv({
				dylib: dylib.data,
				statePath: this.channel.statePath,
				proxy: address,
				...this.launchClock(),
				...(this.deps.debug ? { debug: true } : {}),
			}),
		};
	}

	async confirmLoaded(): DriverResult<void> {
		if (!this.expectLoad) return okVoid;
		this.expectLoad = false;
		const state = this.channel.current();
		if (await this.channel.acked(state.seq, INJECT_LOAD_MS)) return okVoid;
		return {
			success: false,
			error: driverErrors.make(
				"E_INTERNAL",
				`the app did not load libwarden-inject.dylib within ${INJECT_LOAD_MS} ms: network conditions would not reach it. Check the app is a simulator build, and run with WARDEN_E2E_DEBUG=1`,
				{ detail: { statePath: this.channel.statePath } }
			),
		};
	}

	async setClockOffset(ms: number): DriverResult<void> {
		this.clockOffsetMs = Math.trunc(ms);
		this.clockFrozenMs = undefined;
		return this.pushClock();
	}

	async clock(op: ClockCondition, opts?: NetworkOptions): DriverResult<ClockState> {
		const target = this.clockTarget(op, this.now());
		if (!target.success) return target;
		const previous = { offset: this.clockOffsetMs, frozen: this.clockFrozenMs };
		this.clockOffsetMs = target.data.offsetMs;
		this.clockFrozenMs = target.data.frozenMs;
		const relaunched =
			opts?.relaunch === true ? await this.relaunchForClock(opts) : { success: true as const, data: false };
		if (!relaunched.success) {
			this.restoreClock(previous);
			return relaunched;
		}
		const pushed = relaunched.data ? okVoid : await this.pushClock();
		if (!pushed.success) {
			this.restoreClock(previous);
			return pushed;
		}
		const applied = relaunched.data || this.channel.attached() !== undefined;
		return {
			success: true,
			data: {
				condition: op,
				offsetMs: this.clockOffsetMs,
				frozen: this.clockFrozenMs !== undefined,
				nowMs: this.clockFrozenMs ?? this.now() + this.clockOffsetMs,
				...(applied ? {} : { appliesOnLaunch: true as const }),
			},
		};
	}

	private routing(): boolean {
		return this.condition.kind !== "online" || this.faults.length > 0;
	}

	private clockActive(): boolean {
		return this.clockOffsetMs !== 0 || this.clockFrozenMs !== undefined;
	}

	private launchClock(): { clockOffsetMs?: number; clockFrozenMs?: number } {
		return {
			...(this.clockOffsetMs ? { clockOffsetMs: this.clockOffsetMs } : {}),
			...(this.clockFrozenMs === undefined ? {} : { clockFrozenMs: this.clockFrozenMs }),
		};
	}

	private writeState() {
		return this.channel.write({
			offline: this.condition.kind === "offline",
			clockOffsetMs: this.clockOffsetMs,
			...(this.clockFrozenMs === undefined ? {} : { clockFrozenMs: this.clockFrozenMs }),
		});
	}

	private restoreClock(previous: { offset: number; frozen: number | undefined }): void {
		this.clockOffsetMs = previous.offset;
		this.clockFrozenMs = previous.frozen;
	}

	/** Push the current condition + faults to the proxy and the state file. */
	private async push(): DriverResult<{ staged: boolean; injected: boolean }> {
		const conditions = networkProxyShaping.conditionsFor(this.condition, this.faults);
		const live = await this.proxy.current();
		const pushed =
			this.routing() || live
				? await (live ? this.proxy.update(conditions) : this.proxy.ensure(this.condition, conditions))
				: undefined;
		if (pushed && !pushed.success) return driverErrors.err("E_IO", pushed.error);
		const state = this.writeState();
		const attached = this.channel.attached();
		if (!attached) return { success: true, data: { staged: true, injected: false } };
		if (!(await this.channel.acked(state.seq, INJECT_ACK_MS))) {
			return driverErrors.err(
				"E_TIMEOUT",
				`the injected app did not acknowledge the network state within ${INJECT_ACK_MS} ms`,
				{
					detail: { pid: attached.pid, statePath: this.channel.statePath },
				}
			);
		}
		const routed = !this.routing() || attached.proxy === true;
		return { success: true, data: { staged: false, injected: routed } };
	}

	/** A running app that was not launched with the dylib (or without the proxy address) cannot be steered. */
	private async ensureLaunchedInjected(opts: NetworkOptions | undefined): DriverResult<boolean> {
		const bundle = opts?.bundleId ?? this.deps.lastBundle();
		if (!bundle) return { success: true, data: false };
		const running = await this.deps.isRunning(bundle);
		if (!running.success) return running;
		if (!running.data) return { success: true, data: false };
		if (opts?.relaunch) {
			const again = await this.deps.relaunch(bundle);
			return again.success ? { success: true, data: true } : again;
		}
		return driverErrors.err(
			"E_NETWORK_RELAUNCH",
			`${bundle} is running without the warden network dylib, so this condition cannot reach it. It is staged and applies from the next launch: relaunch with \`relaunch: true\` (warden ui: \`network ... --relaunch\`), or launch with inject set`,
			{ detail: { bundleId: bundle } }
		);
	}

	private async apply(opts: NetworkOptions | undefined): DriverResult<boolean> {
		const pushed = await this.push();
		if (!pushed.success) return pushed;
		// an explicit `relaunch` is honoured for `online` too, so the next preset switches live instead of E_NETWORK_RELAUNCH
		if (pushed.data.injected || (!this.routing() && opts?.relaunch !== true)) {
			return { success: true, data: pushed.data.injected };
		}
		const relaunched = await this.ensureLaunchedInjected(opts);
		if (!relaunched.success) return relaunched;
		return { success: true, data: relaunched.data };
	}

	/** Write the clock to the state file and wait for a running injected app to apply it. */
	private async pushClock(): DriverResult<void> {
		const state = this.writeState();
		if (!this.channel.attached()) return okVoid;
		return (await this.channel.acked(state.seq, INJECT_ACK_MS))
			? okVoid
			: driverErrors.err("E_TIMEOUT", `the injected app did not acknowledge the clock within ${INJECT_ACK_MS} ms`);
	}

	/** `relaunch: true`: a running app without the dylib is launched again with it (true = relaunched). */
	private async relaunchForClock(opts: NetworkOptions): DriverResult<boolean> {
		if (this.channel.attached()) return { success: true, data: false };
		const bundle = opts.bundleId ?? this.deps.lastBundle();
		if (!bundle) return { success: true, data: false };
		const running = await this.deps.isRunning(bundle);
		if (!running.success) return running;
		if (!running.data) return { success: true, data: false };
		const again = await this.deps.relaunch(bundle);
		return again.success ? { success: true, data: true } : again;
	}

	/** The offset or frozen instant that puts the wall clock at `op`, given the host time `nowMs`. */
	private clockTarget(op: ClockCondition, nowMs: number): Result<{ offsetMs: number; frozenMs?: number }, DriverError> {
		if (op.kind === "real") return { success: true, data: { offsetMs: 0 } };
		if (op.kind === "offset") return { success: true, data: { offsetMs: Math.trunc(op.ms) } };
		const at = Date.parse(op.at);
		if (Number.isNaN(at)) {
			return {
				success: false,
				error: driverErrors.make("E_BAD_REQUEST", `clock ${op.kind}: "${op.at}" is not an ISO 8601 date-time`),
			};
		}
		return op.kind === "fixed"
			? { success: true, data: { offsetMs: at - nowMs } }
			: { success: true, data: { offsetMs: 0, frozenMs: at } };
	}
}
