import type { HostFault, NetworkCondition } from "@delacour/warden-config/conditions.types";
import { type EmuNetwork, networkPresets } from "@delacour/warden-config/network.presets";
import type {
	Driver,
	DriverError,
	DriverResult,
	NetworkProxyFeature,
	NetworkState,
} from "@delacour/warden-driver/driver.types";
import { driverErrors } from "@delacour/warden-driver/errors";
import { type NetworkProxyPort, networkProxyShaping } from "@delacour/warden-driver/network-proxy";
import type { Exec } from "@delacour/warden-runtime/exec";
import type { AdbSession } from "./adb-session";
import { androidArgv } from "./android-argv";
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

/** The emulator's alias for the host's loopback: a proxy bound to 127.0.0.1 on the host answers here. */
export const EMULATOR_HOST_ALIAS = "10.0.2.2";

export const HTTP_PROXY_GET_ARGV: readonly string[] = ["settings", "get", "global", "http_proxy"];

/** Argv builders and `dumpsys` / console parsers for the network conditions. */
export class AndroidNetworkArgv {
	/** Host argv: `adb -s <serial> emu network speed|delay <value>`. */
	emuNetworkArgv(adb: string, serial: string, what: "speed" | "delay", value: string): string[] {
		return [adb, "-s", serial, "emu", "network", what, value];
	}

	/** Device shell argv. */
	airplaneArgv(enable: boolean): string[] {
		return ["cmd", "connectivity", "airplane-mode", enable ? "enable" : "disable"];
	}

	/** Device shell argvs: the radios by hand, for images whose `cmd connectivity` has no airplane-mode. */
	svcArgvs(enable: boolean): string[][] {
		const verb = enable ? "enable" : "disable";
		return [
			["svc", "wifi", verb],
			["svc", "data", verb],
		];
	}

	/** The emulator console answers `KO: ...` with exit code 0 on a bad argument. */
	emuReplyError(stdout: string): string | undefined {
		const line = stdout.split("\n").find((l) => l.startsWith("KO"));
		return line?.trim();
	}

	/**
	 * The default network out of `dumpsys connectivity`: its header line is `Active default network: 101` while a
	 * network is up and `Active default network: none` when airplane mode or disabled radios took it away. Anything
	 * else (a service that is not there, truncated output) is unreadable.
	 */
	parseActiveNetwork(dump: string): { online: boolean; netId?: number } | undefined {
		const m = /^Active default network:\s*(\d+|none)\s*$/m.exec(dump);
		if (!m) return undefined;
		if (m[1] === "none") return { online: false };
		return { online: true, netId: Number(m[1]) };
	}

	/** Device shell argv: point the system HTTP(S) proxy at `value` (`host:port`, or `:0` to clear). */
	httpProxyPutArgv(value: string): string[] {
		return ["settings", "put", "global", "http_proxy", value];
	}
}

export const androidNetworkArgv = new AndroidNetworkArgv();

export type AndroidNetworkDeps = {
	session: AdbSession;
	/** host runner for `adb emu` */
	exec: Exec;
	adb: string;
	serial: string;
	clock: Clock;
};

type Switch = { ok: true } | { ok: false; error: DriverError };

/**
 * Android network conditions, native first: speed, delay and offline stay on the emulator (`apply`). What the
 * console cannot do, packet loss and per-host faults, goes through the lease's shaping proxy: the system
 * `http_proxy` setting points at it (`10.0.2.2:<port>`) and the proxy applies only `lossPct` and the faults, so the
 * native delay and bandwidth are not applied twice. Apps that honour the system proxy (OkHttp, HttpURLConnection,
 * Chromium WebView, therefore React Native fetch) are covered; raw sockets and apps that set `Proxy.NO_PROXY` are not.
 * Without a proxy port a loss stays in `needsProxy`.
 */
export class AndroidNetwork {
	private readonly proxy: NetworkProxyPort | undefined;
	private condition: NetworkCondition = { kind: "online" };
	private faults: readonly HostFault[] = [];
	private routed = false;

	constructor(private readonly deps: AndroidNetworkDeps & { proxy?: NetworkProxyPort }) {
		this.proxy = deps.proxy;
	}

	/**
	 * Put the emulator's network into `condition`. Offline: airplane mode (radios off by `svc` where the image has no
	 * airplane command). Anything else: back online first, then the preset's / custom speed and delay on the console.
	 * Physical devices have no console. `flap` is the scheduler's: the driver wraps this.
	 */
	async apply(condition: NetworkCondition): DriverResult<NetworkState> {
		const { serial } = this.deps;
		if (!serial.startsWith("emulator-")) {
			return driverErrors.err(
				"E_UNSUPPORTED",
				`network conditions need the emulator console; ${serial} is not an emulator`
			);
		}
		if (condition.kind === "flap") {
			return driverErrors.err(
				"E_UNSUPPORTED",
				"flap is started through the driver's network op (conditions/scheduler.ts), not applied directly"
			);
		}
		const plan = networkPresets.resolveNetwork(condition);
		if (!plan.online) {
			const done = await this.goOffline();
			if (!done.ok) return { success: false, error: done.error };
			return { success: true, data: { online: false, condition, needsProxy: [] } };
		}
		const online = await this.goOnline();
		if (!online.ok) return { success: false, error: online.error };
		const emu = await this.setEmu(plan.emu);
		if (!emu.ok) return { success: false, error: emu.error };
		const needsProxy: NetworkProxyFeature[] = plan.shaping.lossPct > 0 ? ["loss"] : [];
		return { success: true, data: { online: true, condition, needsProxy } };
	}

	readonly network: Driver["network"] = async (op) => {
		const applied = await this.apply(op);
		if (!applied.success) return applied;
		this.condition = op;
		if (!applied.data.online) return applied;
		const wantsProxy = applied.data.needsProxy.includes("loss") || this.faults.length > 0;
		if (!wantsProxy) {
			const cleared = await this.unroute();
			return cleared.success ? applied : cleared;
		}
		if (!this.proxy) return applied;
		const routedNow = await this.route();
		return routedNow.success ? { success: true, data: { ...applied.data, needsProxy: [] } } : routedNow;
	};

	readonly networkFaults: Driver["networkFaults"] = async (next) => {
		const previous = this.faults;
		this.faults = next;
		const plan = networkPresets.resolveNetwork(this.condition);
		const lossPct = plan.online ? plan.shaping.lossPct : 0;
		const result = next.length > 0 || lossPct > 0 ? await this.route() : await this.unroute();
		if (!result.success) {
			this.faults = previous;
			return result;
		}
		return { success: true, data: { notes: networkProxyShaping.faultNotes(next) } };
	};

	private async shell(argv: readonly string[]): Promise<{ ok: boolean; stdout: string }> {
		const res = await this.deps.session.run(androidArgv.shellCommand(argv));
		return res.success ? { ok: res.data.exitCode === 0, stdout: res.data.stdout } : { ok: false, stdout: "" };
	}

	/** Poll `dumpsys connectivity` until the default network is `online`, or `budgetMs` of the clock has gone. */
	private async awaitOnline(online: boolean, budgetMs: number): Promise<boolean> {
		const { clock } = this.deps;
		const deadline = clock.now() + budgetMs;
		for (;;) {
			const dump = await this.shell(DUMPSYS_CONNECTIVITY_ARGV);
			if (androidNetworkArgv.parseActiveNetwork(dump.stdout)?.online === online) return true;
			if (clock.now() >= deadline) return false;
			await clock.sleep(NETWORK_POLL_MS);
		}
	}

	private notReached(online: boolean): Switch {
		const want = online ? "online" : "offline";
		return {
			ok: false,
			error: driverErrors.make(
				"E_TIMEOUT",
				`device did not go ${want}: dumpsys connectivity still reports the opposite`,
				{
					detail: { want },
				}
			),
		};
	}

	private async goOffline(): Promise<Switch> {
		const airplane = await this.shell(androidNetworkArgv.airplaneArgv(true));
		if (airplane.ok && (await this.awaitOnline(false, NETWORK_VERIFY_MS))) return { ok: true };
		for (const argv of androidNetworkArgv.svcArgvs(false)) await this.shell(argv);
		return (await this.awaitOnline(false, NETWORK_VERIFY_MS)) ? { ok: true } : this.notReached(false);
	}

	private async goOnline(): Promise<Switch> {
		await this.shell(androidNetworkArgv.airplaneArgv(false));
		if (await this.awaitOnline(true, AIRPLANE_ONLINE_MS)) return { ok: true };
		for (const argv of androidNetworkArgv.svcArgvs(true)) await this.shell(argv);
		return (await this.awaitOnline(true, NETWORK_VERIFY_MS)) ? { ok: true } : this.notReached(true);
	}

	private async setEmu(emu: EmuNetwork): Promise<Switch> {
		const { adb, serial, exec } = this.deps;
		for (const [what, value] of [
			["speed", emu.speed],
			["delay", emu.delay],
		] as const) {
			const argv = androidNetworkArgv.emuNetworkArgv(adb, serial, what, value);
			const res = await exec(argv);
			if (res.exitCode !== 0) {
				return {
					ok: false,
					error: driverErrors.make(
						"E_IO",
						`\`${argv.join(" ")}\` exited ${res.exitCode}: ${(res.stderr || res.stdout).trim()}`
					),
				};
			}
			const ko = androidNetworkArgv.emuReplyError(res.stdout);
			if (ko)
				return {
					ok: false,
					error: driverErrors.make("E_BAD_REQUEST", `emulator console refused network ${what} ${value}: ${ko}`),
				};
		}
		return { ok: true };
	}

	private async setProxy(value: string): DriverResult<void> {
		const put = await this.shell(androidNetworkArgv.httpProxyPutArgv(value));
		if (!put.ok) return driverErrors.err("E_IO", `settings put global http_proxy ${value} failed`);
		const got = await this.shell(HTTP_PROXY_GET_ARGV);
		return got.stdout.trim() === value
			? { success: true, data: undefined }
			: driverErrors.err("E_IO", `http_proxy reads back ${JSON.stringify(got.stdout.trim())}, not ${value}`);
	}

	private async unroute(): DriverResult<void> {
		if (!this.routed) return { success: true, data: undefined };
		const cleared = await this.setProxy(":0");
		if (cleared.success) this.routed = false;
		return cleared;
	}

	/** Point the device at the proxy with the loss and faults of the current state. */
	private async route(): DriverResult<void> {
		if (!this.proxy)
			return driverErrors.err(
				"E_UNSUPPORTED",
				"per-host faults need a device lease for the shaping proxy: run the spec with `warden e2e` (it sets WARDEN_LEASE_ID); a bare `bun test` has no lease"
			);
		const plan = networkPresets.resolveNetwork(this.condition);
		const lossPct = plan.online ? plan.shaping.lossPct : 0;
		const started = await this.proxy.ensure(this.condition, {
			params: lossPct > 0 ? { lossPct } : {},
			faults: this.faults,
		});
		if (!started.success) return driverErrors.err("E_IO", started.error);
		const set = await this.setProxy(`${EMULATOR_HOST_ALIAS}:${started.data.port}`);
		if (set.success) this.routed = true;
		return set;
	}
}
