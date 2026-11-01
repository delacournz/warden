import { proxyControl } from "@delacour/warden-core/netproxy/control";
import { handleFiles } from "@delacour/warden-core/netproxy/handle-file";
import { LeaseProxyService } from "@delacour/warden-core/netproxy/lease-proxy";
import { leaseClockRecorder } from "@delacour/warden-device/conditions/lease-clock-recorder";
import { lazyLeaseNetworkProxy, leaseNetworkProxy } from "@delacour/warden-device/conditions/lease-network-proxy";
import { spawnDetachedTicker, spawnDetachedTickerVia } from "@delacour/warden-device/conditions/route-ticker.spawn";
import { spawnDetachedScheduler, spawnDetachedSchedulerVia } from "@delacour/warden-device/conditions/scheduler.spawn";
import { driverErrors } from "@delacour/warden-driver/errors";
import { networkProxyShaping } from "@delacour/warden-driver/network-proxy";
import { androidToolsLocator } from "@delacour/warden-providers/android-tools";
import { liveness } from "@delacour/warden-store/liveness";
import { processCommand } from "@delacour/warden-store/process-identity";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { NETPROXY_SUBCOMMAND } from "../e2e/bun-runner";
import { compiledSubcommand } from "../self-command";
import type { ConditionsDeps, ConditionsPort } from "./conditions-types";
import type { UiDevice } from "./device";
import { driverUiError } from "./driver";
import type { UiError } from "./output";

const GEO_FIX_MS = 10_000;

function proxyDeps(ctx: CommandContext) {
	const command = compiledSubcommand(NETPROXY_SUBCOMMAND);
	return { store: ctx.store(), env: ctx.env, now: ctx.now, ...(command ? { command } : {}) };
}

/** What a `warden ui` driver gets for the caller's lease: its shaping proxy (touched only when a condition needs it) and the clock recorder. */
export function leaseDriverExtras(ctx: CommandContext, device: UiDevice) {
	const command = compiledSubcommand(NETPROXY_SUBCOMMAND);
	return {
		networkProxy: lazyLeaseNetworkProxy({
			leaseId: device.lease.id,
			env: ctx.env,
			now: ctx.now,
			openStore: () => ({ success: true, data: ctx.store() }),
			...(command ? { command } : {}),
		}),
		clockRecorder: leaseClockRecorder(ctx.store(), device.lease.id, ctx.now),
	};
}

/** iOS: the device helper's driver, with the lease's shaping proxy so `network` / `networkFaults` work. */
async function openIos(ctx: CommandContext, device: UiDevice): Promise<Result<ConditionsPort, UiError>> {
	const { connectHelper } = await import("./helper");
	return connectHelper(ctx, device.udid, {}, leaseDriverExtras(ctx, device));
}

/**
 * Android without the full driver (no animation changes, no uiad, no host): the resident adb shell for network and
 * `adb emu geo fix` for a point. A moving location is the route ticker's job.
 */
async function openAndroid(ctx: CommandContext, device: UiDevice): Promise<Result<ConditionsPort, UiError>> {
	const [
		{ openAdbSession },
		{ createAndroidNetwork },
		{ geoFixArgv, geoFixFailure },
		{ realClock },
		{ applyAndroidClock },
		{ createAndroidSettings },
	] = await Promise.all([
		import("@delacour/warden-driver-android/adb-session"),
		import("@delacour/warden-driver-android/android-network"),
		import("@delacour/warden-driver-android/android-argv"),
		import("@delacour/warden-driver-android/android-device"),
		import("@delacour/warden-driver-android/android-clock"),
		import("@delacour/warden-driver-android/android-settings"),
	]);
	const serial = device.udid;
	const { adb } = androidToolsLocator.locate(ctx.env);
	const session = openAdbSession({ adb, serial });
	const net = createAndroidNetwork({
		session,
		exec: ctx.exec,
		adb,
		serial,
		clock: realClock,
		proxy: leaseNetworkProxy(proxyDeps(ctx), device.lease),
	});
	const settings = createAndroidSettings({ session, serial });
	return resultFactory.ok({
		...settings,
		network: net.network,
		networkFaults: net.networkFaults,
		location: async (op) => {
			if (!serial.startsWith("emulator-")) {
				return driverErrors.err("E_UNSUPPORTED", `location needs an emulator; ${serial} has no emulator console`);
			}
			if (op.kind === "clear") return { success: true, data: undefined };
			if (op.kind !== "point") {
				return driverErrors.err(
					"E_BAD_REQUEST",
					`a ${op.kind} location is played by the route ticker, not set directly`
				);
			}
			const res = await ctx.exec(geoFixArgv(adb, serial, op, op.altM), { timeoutMs: GEO_FIX_MS });
			const failure = geoFixFailure(res);
			return failure === undefined ? { success: true, data: undefined } : driverErrors.err("E_IO", failure);
		},
		clock: (op) => applyAndroidClock({ session, exec: ctx.exec, adb, serial }, op),
		close: () => session.close(),
	});
}

type Spawn = Parameters<typeof spawnDetachedTickerVia>[2];

/**
 * How the detached scheduler / ticker start: a compiled warden has no script to hand `bun`, so it runs its own hidden
 * `__scheduler` / `__route-ticker`; from source they run `bun scheduler.main.ts` / `route-ticker.main.ts` (no second CLI start).
 */
export function conditionSpawners(main: string = Bun.main, execPath: string = process.execPath, spawn?: Spawn) {
	return {
		spawnScheduler: (config: Parameters<typeof spawnDetachedScheduler>[0]) => {
			const via = compiledSubcommand("__scheduler", main, execPath);
			return via ? spawnDetachedSchedulerVia(config, via, spawn) : spawnDetachedScheduler(config, spawn);
		},
		spawnTicker: (config: Parameters<typeof spawnDetachedTicker>[0]) => {
			const via = compiledSubcommand("__route-ticker", main, execPath);
			return via ? spawnDetachedTickerVia(config, via, spawn) : spawnDetachedTicker(config, spawn);
		},
	};
}

/** Real side effects of the condition verbs. */
export const realConditionsDeps: Required<ConditionsDeps> = {
	open: async (ctx, device) => {
		try {
			return device.platform === "ios" ? await openIos(ctx, device) : await openAndroid(ctx, device);
		} catch (error) {
			return { success: false, error: driverUiError({ code: "E_INTERNAL", message: String(error), retryable: false }) };
		}
	},
	...conditionSpawners(),
	kill: (pid) => {
		process.kill(pid, "SIGTERM");
	},
	proxyStatus: async (ctx, leaseId) => {
		const handle = handleFiles.read(handleFiles.path(leaseId, ctx.env));
		if (!handle || !liveness.processAlive(handle.pid)) return undefined;
		const status = await proxyControl.status(handle);
		return status.success ? { ...status.data, port: handle.port } : undefined;
	},
	proxyPid: (ctx, leaseId) => {
		const handle = handleFiles.read(handleFiles.path(leaseId, ctx.env));
		return handle && liveness.processAlive(handle.pid) ? handle.pid : undefined;
	},
	command: processCommand,
	adb: (ctx) => androidToolsLocator.locate(ctx.env).adb,
	ensureProxy: async (ctx, lease) => {
		const started = await new LeaseProxyService(proxyDeps(ctx)).ensure(lease, {
			condition: { kind: "online" },
			conditions: networkProxyShaping.conditionsFor({ kind: "online" }, []),
		});
		return started.success ? resultFactory.ok(undefined) : { success: false, error: started.error };
	},
};
