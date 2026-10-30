import type { ClockCondition, HostFault, NetworkCondition } from "@delacour/warden-core/conditions/conditions.types";
import { resolveNetwork } from "@delacour/warden-core/conditions/network.presets";
import type { Result } from "@delacour/warden-types/result";
import type {
	ClockState,
	DriverError,
	DriverResult,
	LaunchOptions,
	NetworkOptions,
	NetworkState,
} from "../driver.types";
import { driverErr, driverError } from "../errors";
import { faultNotes, type NetworkProxyPort, proxyConditionsFor } from "../network-proxy";
import { type InjectChannel, injectLaunchEnv, shouldInject } from "./inject";

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

export function createIosNetwork(deps: IosNetworkDeps): IosNetwork {
	const { proxy, channel } = deps;
	let condition: NetworkCondition = { kind: "online" };
	let faults: readonly HostFault[] = [];
	let clockOffsetMs = channel.current().clockOffsetMs ?? 0;
	let clockFrozenMs: number | undefined = channel.current().clockFrozenMs;
	const now = deps.now ?? Date.now;
	let expectLoad = false;

	const routing = () => condition.kind !== "online" || faults.length > 0;
	const clockActive = () => clockOffsetMs !== 0 || clockFrozenMs !== undefined;
	const launchClock = (): { clockOffsetMs?: number; clockFrozenMs?: number } => ({
		...(clockOffsetMs ? { clockOffsetMs } : {}),
		...(clockFrozenMs === undefined ? {} : { clockFrozenMs }),
	});
	const writeState = () =>
		channel.write({
			offline: condition.kind === "offline",
			clockOffsetMs,
			...(clockFrozenMs === undefined ? {} : { clockFrozenMs }),
		});

	/** Push the current condition + faults to the proxy and the state file. */
	async function push(): DriverResult<{ staged: boolean; injected: boolean }> {
		const conditions = proxyConditionsFor(condition, faults);
		const live = await proxy.current();
		const pushed =
			routing() || live ? await (live ? proxy.update(conditions) : proxy.ensure(condition, conditions)) : undefined;
		if (pushed && !pushed.success) return driverErr("E_IO", pushed.error);
		const state = writeState();
		const attached = channel.attached();
		if (!attached) return { success: true, data: { staged: true, injected: false } };
		if (!(await channel.acked(state.seq, INJECT_ACK_MS))) {
			return driverErr(
				"E_TIMEOUT",
				`the injected app did not acknowledge the network state within ${INJECT_ACK_MS} ms`,
				{
					detail: { pid: attached.pid, statePath: channel.statePath },
				}
			);
		}
		const routed = !routing() || attached.proxy === true;
		return { success: true, data: { staged: false, injected: routed } };
	}

	/** A running app that was not launched with the dylib (or without the proxy address) cannot be steered. */
	async function ensureLaunchedInjected(opts: NetworkOptions | undefined): DriverResult<boolean> {
		const bundle = opts?.bundleId ?? deps.lastBundle();
		if (!bundle) return { success: true, data: false };
		const running = await deps.isRunning(bundle);
		if (!running.success) return running;
		if (!running.data) return { success: true, data: false };
		if (opts?.relaunch) {
			const again = await deps.relaunch(bundle);
			return again.success ? { success: true, data: true } : again;
		}
		return driverErr(
			"E_NETWORK_RELAUNCH",
			`${bundle} is running without the warden network dylib, so this condition cannot reach it. It is staged and applies from the next launch: relaunch with \`relaunch: true\` (warden ui: \`network ... --relaunch\`), or launch with inject set`,
			{ detail: { bundleId: bundle } }
		);
	}

	async function apply(opts: NetworkOptions | undefined): DriverResult<boolean> {
		const pushed = await push();
		if (!pushed.success) return pushed;
		// an explicit `relaunch` is honoured for `online` too, so the next preset switches live instead of E_NETWORK_RELAUNCH
		if (pushed.data.injected || (!routing() && opts?.relaunch !== true)) {
			return { success: true, data: pushed.data.injected };
		}
		const relaunched = await ensureLaunchedInjected(opts);
		if (!relaunched.success) return relaunched;
		return { success: true, data: relaunched.data };
	}

	/** Write the clock to the state file and wait for a running injected app to apply it. */
	async function pushClock(): DriverResult<void> {
		const state = writeState();
		if (!channel.attached()) return okVoid;
		return (await channel.acked(state.seq, INJECT_ACK_MS))
			? okVoid
			: driverErr("E_TIMEOUT", `the injected app did not acknowledge the clock within ${INJECT_ACK_MS} ms`);
	}

	/** `relaunch: true`: a running app without the dylib is launched again with it (true = relaunched). */
	async function relaunchForClock(opts: NetworkOptions): DriverResult<boolean> {
		if (channel.attached()) return { success: true, data: false };
		const bundle = opts.bundleId ?? deps.lastBundle();
		if (!bundle) return { success: true, data: false };
		const running = await deps.isRunning(bundle);
		if (!running.success) return running;
		if (!running.data) return { success: true, data: false };
		const again = await deps.relaunch(bundle);
		return again.success ? { success: true, data: true } : again;
	}

	return {
		async network(op, opts) {
			if (op.kind === "flap") {
				return driverErr(
					"E_UNSUPPORTED",
					"flap is run by the condition scheduler (COND-6) as online/offline transitions"
				);
			}
			const previous = condition;
			condition = op;
			const applied = await apply(opts);
			if (!applied.success) {
				if (applied.error.code !== "E_NETWORK_RELAUNCH") condition = previous;
				return applied;
			}
			const plan = resolveNetwork(op);
			return {
				success: true,
				data: {
					online: plan.online,
					condition: op,
					needsProxy: [],
					...(applied.data || !routing() ? {} : { appliesOnLaunch: true as const }),
				},
			};
		},
		async networkFaults(next) {
			const previous = faults;
			faults = next;
			const applied = await apply(undefined);
			if (!applied.success) {
				if (applied.error.code !== "E_NETWORK_RELAUNCH") faults = previous;
				return applied;
			}
			return { success: true, data: { notes: faultNotes(next) } };
		},
		async launchEnv(opts) {
			const live = await proxy.current();
			if (
				!shouldInject({
					networkActive: live !== undefined,
					clockActive: clockActive(),
					requested: opts.inject === true,
				})
			) {
				// a plain launch has no dylib: forget the ack of an earlier app so `attached()` never reports a ghost
				channel.reset();
				return { success: true, data: undefined };
			}
			const dylib = deps.dylib();
			if (!dylib.success) return dylib;
			let address = live;
			if (!address && (routing() || opts.inject === true)) {
				const started = await proxy.ensure(condition, proxyConditionsFor(condition, faults));
				if (!started.success) return driverErr("E_IO", started.error);
				address = started.data;
			}
			channel.reset();
			writeState();
			expectLoad = true;
			return {
				success: true,
				data: injectLaunchEnv({
					dylib: dylib.data,
					statePath: channel.statePath,
					proxy: address,
					...launchClock(),
					...(deps.debug ? { debug: true } : {}),
				}),
			};
		},
		async confirmLoaded() {
			if (!expectLoad) return okVoid;
			expectLoad = false;
			const state = channel.current();
			if (await channel.acked(state.seq, INJECT_LOAD_MS)) return okVoid;
			return {
				success: false,
				error: driverError(
					"E_INTERNAL",
					`the app did not load libwarden-inject.dylib within ${INJECT_LOAD_MS} ms: network conditions would not reach it. Check the app is a simulator build, and run with WARDEN_E2E_DEBUG=1`,
					{ detail: { statePath: channel.statePath } }
				),
			};
		},
		async setClockOffset(ms) {
			clockOffsetMs = Math.trunc(ms);
			clockFrozenMs = undefined;
			return pushClock();
		},
		async clock(op, opts) {
			const target = clockTarget(op, now());
			if (!target.success) return target;
			const previous = { offset: clockOffsetMs, frozen: clockFrozenMs };
			clockOffsetMs = target.data.offsetMs;
			clockFrozenMs = target.data.frozenMs;
			const relaunched =
				opts?.relaunch === true ? await relaunchForClock(opts) : { success: true as const, data: false };
			if (!relaunched.success) {
				clockOffsetMs = previous.offset;
				clockFrozenMs = previous.frozen;
				return relaunched;
			}
			const pushed = relaunched.data ? okVoid : await pushClock();
			if (!pushed.success) {
				clockOffsetMs = previous.offset;
				clockFrozenMs = previous.frozen;
				return pushed;
			}
			const applied = relaunched.data || channel.attached() !== undefined;
			return {
				success: true,
				data: {
					condition: op,
					offsetMs: clockOffsetMs,
					frozen: clockFrozenMs !== undefined,
					nowMs: clockFrozenMs ?? now() + clockOffsetMs,
					...(applied ? {} : { appliesOnLaunch: true as const }),
				},
			};
		},
	};
}

/** The offset or frozen instant that puts the wall clock at `op`, given the host time `nowMs`. */
function clockTarget(op: ClockCondition, nowMs: number): Result<{ offsetMs: number; frozenMs?: number }, DriverError> {
	if (op.kind === "real") return { success: true, data: { offsetMs: 0 } };
	if (op.kind === "offset") return { success: true, data: { offsetMs: Math.trunc(op.ms) } };
	const at = Date.parse(op.at);
	if (Number.isNaN(at)) {
		return {
			success: false,
			error: driverError("E_BAD_REQUEST", `clock ${op.kind}: "${op.at}" is not an ISO 8601 date-time`),
		};
	}
	return op.kind === "fixed"
		? { success: true, data: { offsetMs: at - nowMs } }
		: { success: true, data: { offsetMs: 0, frozenMs: at } };
}
