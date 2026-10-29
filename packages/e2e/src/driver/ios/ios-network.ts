import type { HostFault, NetworkCondition } from "@delacour/warden-core/conditions/conditions.types";
import { resolveNetwork } from "@delacour/warden-core/conditions/network.presets";
import type { Result } from "@delacour/warden-types/result";
import type { DriverError, DriverResult, LaunchOptions, NetworkOptions, NetworkState } from "../driver.types";
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
};

const okVoid = { success: true as const, data: undefined };

export function createIosNetwork(deps: IosNetworkDeps): IosNetwork {
	const { proxy, channel } = deps;
	let condition: NetworkCondition = { kind: "online" };
	let faults: readonly HostFault[] = [];
	let clockOffsetMs = channel.current().clockOffsetMs ?? 0;
	let expectLoad = false;

	const routing = () => condition.kind !== "online" || faults.length > 0;
	const writeState = () => channel.write({ offline: condition.kind === "offline", clockOffsetMs });

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
		if (!running.success || !running.data) return { success: true, data: false };
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
		if (pushed.data.injected || !routing()) return { success: true, data: pushed.data.injected };
		const relaunched = await ensureLaunchedInjected(opts);
		if (!relaunched.success) return relaunched;
		return { success: true, data: relaunched.data };
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
					clockActive: clockOffsetMs !== 0,
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
					...(clockOffsetMs ? { clockOffsetMs } : {}),
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
			const state = writeState();
			if (!channel.attached()) return okVoid;
			return (await channel.acked(state.seq, INJECT_ACK_MS))
				? okVoid
				: driverErr("E_TIMEOUT", `the injected app did not acknowledge the clock offset within ${INJECT_ACK_MS} ms`);
		},
	};
}
