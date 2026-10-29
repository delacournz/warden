import type { HostFault, NetworkCondition } from "@delacour/warden-core/conditions/conditions.types";
import { type EmuNetwork, resolveNetwork } from "@delacour/warden-core/conditions/network.presets";
import type { Exec } from "@delacour/warden-core/exec";
import type { Driver, DriverError, DriverResult, NetworkProxyFeature, NetworkState } from "../driver.types";
import { driverErr, driverError } from "../errors";
import { faultNotes, type NetworkProxyPort } from "../network-proxy";
import type { AdbSession } from "./adb-session";
import { shellCommand } from "./android-argv";
import type { Clock } from "./android-device";

/**
 * Android native network conditions. Speed and delay go to the emulator console (`adb emu network ...`, host
 * side); online/offline is airplane mode (`cmd connectivity`, falling back to `svc wifi|data`). Every switch is
 * verified against what `dumpsys connectivity` reports, polled on the injected clock, before it returns.
 * Loss, per-host faults and flapping are not native: loss is reported in `needsProxy` (COND-4), the rest never
 * reach this driver.
 */

/** Longest wait for the OS to agree with one switch. */
export const NETWORK_VERIFY_MS = 10_000;
/** How long airplane mode gets to bring the network back before `svc wifi|data enable` is also tried. */
const AIRPLANE_ONLINE_MS = 3_000;
const NETWORK_POLL_MS = 250;

export const DUMPSYS_CONNECTIVITY_ARGV: readonly string[] = ["dumpsys", "connectivity"];

/** Host argv: `adb -s <serial> emu network speed|delay <value>`. */
export function emuNetworkArgv(adb: string, serial: string, what: "speed" | "delay", value: string): string[] {
	return [adb, "-s", serial, "emu", "network", what, value];
}

/** Device shell argv. */
export function airplaneArgv(enable: boolean): string[] {
	return ["cmd", "connectivity", "airplane-mode", enable ? "enable" : "disable"];
}

/** Device shell argvs: the radios by hand, for images whose `cmd connectivity` has no airplane-mode. */
export function svcArgvs(enable: boolean): string[][] {
	const verb = enable ? "enable" : "disable";
	return [
		["svc", "wifi", verb],
		["svc", "data", verb],
	];
}

/** The emulator console answers `KO: ...` with exit code 0 on a bad argument. */
export function emuReplyError(stdout: string): string | undefined {
	const line = stdout.split("\n").find((l) => l.startsWith("KO"));
	return line?.trim();
}

/**
 * The default network out of `dumpsys connectivity`: its header line is `Active default network: 101` while a
 * network is up and `Active default network: none` when airplane mode or disabled radios took it away. Anything
 * else (a service that is not there, truncated output) is unreadable.
 */
export function parseActiveNetwork(dump: string): { online: boolean; netId?: number } | undefined {
	const m = /^Active default network:\s*(\d+|none)\s*$/m.exec(dump);
	if (!m) return undefined;
	if (m[1] === "none") return { online: false };
	return { online: true, netId: Number(m[1]) };
}

export type AndroidNetworkDeps = {
	session: AdbSession;
	/** host runner for `adb emu` */
	exec: Exec;
	adb: string;
	serial: string;
	clock: Clock;
};

type Switch = { ok: true } | { ok: false; error: DriverError };

async function shell(deps: AndroidNetworkDeps, argv: readonly string[]): Promise<{ ok: boolean; stdout: string }> {
	const res = await deps.session.run(shellCommand(argv));
	return res.success ? { ok: res.data.exitCode === 0, stdout: res.data.stdout } : { ok: false, stdout: "" };
}

/** Poll `dumpsys connectivity` until the default network is `online`, or `budgetMs` of the clock has gone. */
async function awaitOnline(deps: AndroidNetworkDeps, online: boolean, budgetMs: number): Promise<boolean> {
	const deadline = deps.clock.now() + budgetMs;
	for (;;) {
		const dump = await shell(deps, DUMPSYS_CONNECTIVITY_ARGV);
		if (parseActiveNetwork(dump.stdout)?.online === online) return true;
		if (deps.clock.now() >= deadline) return false;
		await deps.clock.sleep(NETWORK_POLL_MS);
	}
}

function notReached(online: boolean): Switch {
	const want = online ? "online" : "offline";
	return {
		ok: false,
		error: driverError("E_TIMEOUT", `device did not go ${want}: dumpsys connectivity still reports the opposite`, {
			detail: { want },
		}),
	};
}

async function goOffline(deps: AndroidNetworkDeps): Promise<Switch> {
	const airplane = await shell(deps, airplaneArgv(true));
	if (airplane.ok && (await awaitOnline(deps, false, NETWORK_VERIFY_MS))) return { ok: true };
	for (const argv of svcArgvs(false)) await shell(deps, argv);
	return (await awaitOnline(deps, false, NETWORK_VERIFY_MS)) ? { ok: true } : notReached(false);
}

async function goOnline(deps: AndroidNetworkDeps): Promise<Switch> {
	await shell(deps, airplaneArgv(false));
	if (await awaitOnline(deps, true, AIRPLANE_ONLINE_MS)) return { ok: true };
	for (const argv of svcArgvs(true)) await shell(deps, argv);
	return (await awaitOnline(deps, true, NETWORK_VERIFY_MS)) ? { ok: true } : notReached(true);
}

async function setEmu(deps: AndroidNetworkDeps, emu: EmuNetwork): Promise<Switch> {
	for (const [what, value] of [
		["speed", emu.speed],
		["delay", emu.delay],
	] as const) {
		const argv = emuNetworkArgv(deps.adb, deps.serial, what, value);
		const res = await deps.exec(argv);
		if (res.exitCode !== 0) {
			return {
				ok: false,
				error: driverError(
					"E_IO",
					`\`${argv.join(" ")}\` exited ${res.exitCode}: ${(res.stderr || res.stdout).trim()}`
				),
			};
		}
		const ko = emuReplyError(res.stdout);
		if (ko)
			return {
				ok: false,
				error: driverError("E_BAD_REQUEST", `emulator console refused network ${what} ${value}: ${ko}`),
			};
	}
	return { ok: true };
}

/**
 * Put the emulator's network into `condition`. Offline: airplane mode (radios off by `svc` where the image has no
 * airplane command). Anything else: back online first, then the preset's / custom speed and delay on the console.
 * Physical devices have no console. `flap` is the scheduler's: the driver wraps this.
 */
export async function applyAndroidNetwork(
	deps: AndroidNetworkDeps,
	condition: NetworkCondition
): DriverResult<NetworkState> {
	if (!deps.serial.startsWith("emulator-")) {
		return driverErr(
			"E_UNSUPPORTED",
			`network conditions need the emulator console; ${deps.serial} is not an emulator`
		);
	}
	if (condition.kind === "flap") {
		return driverErr(
			"E_UNSUPPORTED",
			"flap is started through the driver's network op (conditions/scheduler.ts), not applied directly"
		);
	}
	const plan = resolveNetwork(condition);
	if (!plan.online) {
		const done = await goOffline(deps);
		if (!done.ok) return { success: false, error: done.error };
		return { success: true, data: { online: false, condition, needsProxy: [] } };
	}
	const online = await goOnline(deps);
	if (!online.ok) return { success: false, error: online.error };
	const emu = await setEmu(deps, plan.emu);
	if (!emu.ok) return { success: false, error: emu.error };
	const needsProxy: NetworkProxyFeature[] = plan.shaping.lossPct > 0 ? ["loss"] : [];
	return { success: true, data: { online: true, condition, needsProxy } };
}

/** The emulator's alias for the host's loopback: a proxy bound to 127.0.0.1 on the host answers here. */
export const EMULATOR_HOST_ALIAS = "10.0.2.2";

/** Device shell argv: point the system HTTP(S) proxy at `value` (`host:port`, or `:0` to clear). */
export function httpProxyPutArgv(value: string): string[] {
	return ["settings", "put", "global", "http_proxy", value];
}
export const HTTP_PROXY_GET_ARGV: readonly string[] = ["settings", "get", "global", "http_proxy"];

/**
 * Android network conditions, native first: speed, delay and offline stay on the emulator (`applyAndroidNetwork`).
 * What the console cannot do, packet loss and per-host faults, goes through the lease's shaping proxy: the system
 * `http_proxy` setting points at it (`10.0.2.2:<port>`) and the proxy applies only `lossPct` and the faults, so the
 * native delay and bandwidth are not applied twice. Apps that honour the system proxy (OkHttp, HttpURLConnection,
 * Chromium WebView, therefore React Native fetch) are covered; raw sockets and apps that set `Proxy.NO_PROXY` are not.
 * Without a proxy port a loss stays in `needsProxy`.
 */
export function createAndroidNetwork(deps: AndroidNetworkDeps & { proxy?: NetworkProxyPort }): {
	network: Driver["network"];
	networkFaults: Driver["networkFaults"];
} {
	const { proxy } = deps;
	let condition: NetworkCondition = { kind: "online" };
	let faults: readonly HostFault[] = [];
	let routed = false;

	const setProxy = async (value: string): DriverResult<void> => {
		const put = await shell(deps, httpProxyPutArgv(value));
		if (!put.ok) return driverErr("E_IO", `settings put global http_proxy ${value} failed`);
		const got = await shell(deps, HTTP_PROXY_GET_ARGV);
		return got.stdout.trim() === value
			? { success: true, data: undefined }
			: driverErr("E_IO", `http_proxy reads back ${JSON.stringify(got.stdout.trim())}, not ${value}`);
	};

	const unroute = async (): DriverResult<void> => {
		if (!routed) return { success: true, data: undefined };
		const cleared = await setProxy(":0");
		if (cleared.success) routed = false;
		return cleared;
	};

	/** Point the device at the proxy with the loss and faults of the current state. */
	const route = async (): DriverResult<void> => {
		if (!proxy)
			return driverErr(
				"E_UNSUPPORTED",
				"per-host faults need a device lease for the shaping proxy: run the spec with `warden e2e` (it sets WARDEN_LEASE_ID); a bare `bun test` has no lease"
			);
		const plan = resolveNetwork(condition);
		const lossPct = plan.online ? plan.shaping.lossPct : 0;
		const started = await proxy.ensure(condition, { params: lossPct > 0 ? { lossPct } : {}, faults });
		if (!started.success) return driverErr("E_IO", started.error);
		const set = await setProxy(`${EMULATOR_HOST_ALIAS}:${started.data.port}`);
		if (set.success) routed = true;
		return set;
	};

	return {
		async network(op) {
			const applied = await applyAndroidNetwork(deps, op);
			if (!applied.success) return applied;
			condition = op;
			if (!applied.data.online) return applied;
			const wantsProxy = applied.data.needsProxy.includes("loss") || faults.length > 0;
			if (!wantsProxy) {
				const cleared = await unroute();
				return cleared.success ? applied : cleared;
			}
			if (!proxy) return applied;
			const routedNow = await route();
			return routedNow.success ? { success: true, data: { ...applied.data, needsProxy: [] } } : routedNow;
		},
		async networkFaults(next) {
			const previous = faults;
			faults = next;
			const plan = resolveNetwork(condition);
			const lossPct = plan.online ? plan.shaping.lossPct : 0;
			const result = next.length > 0 || lossPct > 0 ? await route() : await unroute();
			if (!result.success) {
				faults = previous;
				return result;
			}
			return { success: true, data: { notes: faultNotes(next) } };
		},
	};
}
