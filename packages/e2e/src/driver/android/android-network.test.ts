import { describe, expect, test } from "bun:test";
import { fakeProxy } from "../network-proxy.testing";
import { openAdbSession } from "./adb-session";
import { fakeAndroidHost, type ShellRule } from "./android-host.testing";
import {
	airplaneArgv,
	applyAndroidNetwork,
	createAndroidNetwork,
	DUMPSYS_CONNECTIVITY_ARGV,
	EMULATOR_HOST_ALIAS,
	emuNetworkArgv,
	emuReplyError,
	httpProxyPutArgv,
	parseActiveNetwork,
	svcArgvs,
} from "./android-network";
import { DUMPSYS_AIRPLANE, DUMPSYS_ONLINE, DUMPSYS_SVC_OFF } from "./network.fixture";

describe("argv builders", () => {
	test("emu network speed / delay are host adb argv on the serial", () => {
		expect(emuNetworkArgv("/sdk/adb", "emulator-5554", "speed", "200:240")).toEqual([
			"/sdk/adb",
			"-s",
			"emulator-5554",
			"emu",
			"network",
			"speed",
			"200:240",
		]);
		expect(emuNetworkArgv("adb", "s", "delay", "none").slice(3)).toEqual(["emu", "network", "delay", "none"]);
	});

	test("airplane mode and svc argv", () => {
		expect(airplaneArgv(true)).toEqual(["cmd", "connectivity", "airplane-mode", "enable"]);
		expect(airplaneArgv(false)).toEqual(["cmd", "connectivity", "airplane-mode", "disable"]);
		expect(svcArgvs(false)).toEqual([
			["svc", "wifi", "disable"],
			["svc", "data", "disable"],
		]);
		expect(svcArgvs(true)).toEqual([
			["svc", "wifi", "enable"],
			["svc", "data", "enable"],
		]);
		expect(DUMPSYS_CONNECTIVITY_ARGV).toEqual(["dumpsys", "connectivity"]);
	});
});

describe("emuReplyError", () => {
	test("the console answers KO with exit 0", () => {
		expect(emuReplyError("KO: invalid <speed> argument, see 'help network speed' for valid values\n")).toContain(
			"invalid <speed>"
		);
		expect(emuReplyError("OK\n")).toBeUndefined();
		expect(emuReplyError("")).toBeUndefined();
	});
});

describe("parseActiveNetwork (real dumpsys connectivity)", () => {
	test("online: a network id", () => {
		expect(parseActiveNetwork(DUMPSYS_ONLINE)).toEqual({ online: true, netId: 105 });
	});

	test("airplane mode: none", () => {
		expect(parseActiveNetwork(DUMPSYS_AIRPLANE)).toEqual({ online: false });
	});

	test("wifi and data disabled by svc: none", () => {
		expect(parseActiveNetwork(DUMPSYS_SVC_OFF)).toEqual({ online: false });
	});

	test("anything else is unreadable", () => {
		expect(parseActiveNetwork("")).toBeUndefined();
		expect(parseActiveNetwork("Can't find service: connectivity\n")).toBeUndefined();
	});
});

/** A device whose connectivity follows a tiny model: airplane / svc flags decide what `dumpsys` prints. */
function device(opts: { airplane?: "ok" | "unsupported"; settleAfterPolls?: number; emu?: string } = {}) {
	let airplane = false;
	let wifi = true;
	let data = true;
	let polls = 0;
	const rules: ShellRule[] = [
		{
			match: "cmd connectivity airplane-mode",
			reply: (cmd) => {
				if (opts.airplane === "unsupported") return { stdout: "No shell command implementation.\n", exitCode: 255 };
				airplane = cmd.endsWith("enable");
				return "";
			},
		},
		{
			match: "svc wifi",
			reply: (cmd) => {
				wifi = cmd.endsWith("enable");
				return "";
			},
		},
		{
			match: "svc data",
			reply: (cmd) => {
				data = cmd.endsWith("enable");
				return "";
			},
		},
		{
			match: "dumpsys connectivity",
			reply: () => {
				polls++;
				const settled = polls > (opts.settleAfterPolls ?? 0);
				const up = !airplane && (wifi || data);
				const showing = settled ? up : !up;
				return showing ? DUMPSYS_ONLINE : DUMPSYS_AIRPLANE;
			},
		},
	];
	const host = fakeAndroidHost({
		shell: rules,
		host: [{ match: /emu network/, reply: opts.emu ?? "OK\n" }],
	});
	return { host, polls: () => polls, state: () => ({ airplane, wifi, data }) };
}

function fakeClock() {
	let t = 0;
	return {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms;
		},
	};
}

async function run(
	d: ReturnType<typeof device>,
	condition: Parameters<typeof applyAndroidNetwork>[1],
	serial = "emulator-5554"
) {
	const session = openAdbSession({ adb: "adb", serial, spawn: d.host.spawn });
	const clock = fakeClock();
	try {
		const result = await applyAndroidNetwork({ session, exec: d.host.exec, adb: "adb", serial, clock }, condition);
		return { result, clock };
	} finally {
		await session.close();
	}
}

describe("applyAndroidNetwork", () => {
	test("offline: airplane on, verified through dumpsys", async () => {
		const d = device();
		const { result } = await run(d, { kind: "offline" });
		expect(result).toEqual({ success: true, data: { online: false, condition: { kind: "offline" }, needsProxy: [] } });
		expect(d.host.shell).toContain("cmd connectivity airplane-mode enable");
		expect(d.host.shell.some((c) => c.startsWith("dumpsys connectivity"))).toBe(true);
		expect(d.host.host).toEqual([]);
	});

	test("polls on the injected clock until the OS agrees, never a blind sleep", async () => {
		const d = device({ settleAfterPolls: 3 });
		const { result, clock } = await run(d, { kind: "offline" });
		expect(result.success).toBe(true);
		expect(d.polls()).toBe(4);
		expect(clock.now()).toBeGreaterThan(0);
		expect(clock.now()).toBeLessThan(2_000);
	});

	test("offline that never takes effect is E_TIMEOUT after the bounded wait", async () => {
		const d = device({ settleAfterPolls: 1_000_000 });
		const { result, clock } = await run(d, { kind: "offline" });
		if (result.success) throw new Error("expected failure");
		expect(result.error.code).toBe("E_TIMEOUT");
		expect(result.error.retryable).toBe(true);
		expect(clock.now()).toBeLessThanOrEqual(30_000);
	});

	test("airplane mode unsupported: falls back to svc wifi + data off", async () => {
		const d = device({ airplane: "unsupported" });
		const { result } = await run(d, { kind: "offline" });
		expect(result.success && result.data.online).toBe(false);
		expect(d.state()).toEqual({ airplane: false, wifi: false, data: false });
		expect(d.host.shell).toContain("svc wifi disable");
		expect(d.host.shell).toContain("svc data disable");
	});

	test("online reverses airplane mode and resets speed and delay", async () => {
		const d = device();
		await run(d, { kind: "offline" });
		const { result } = await run(d, { kind: "online" });
		expect(result).toEqual({ success: true, data: { online: true, condition: { kind: "online" }, needsProxy: [] } });
		expect(d.state().airplane).toBe(false);
		expect(d.host.host.map((a) => a.slice(3).join(" "))).toEqual(["emu network speed full", "emu network delay none"]);
	});

	test("online after a svc fallback offline turns wifi and data back on", async () => {
		const d = device({ airplane: "unsupported" });
		await run(d, { kind: "offline" });
		const { result } = await run(d, { kind: "online" });
		expect(result.success && result.data.online).toBe(true);
		expect(d.state()).toEqual({ airplane: false, wifi: true, data: true });
	});

	test("preset: online first, then emulator speed and delay from the table", async () => {
		const d = device();
		const { result } = await run(d, { kind: "preset", preset: "edge" });
		expect(result).toEqual({
			success: true,
			data: { online: true, condition: { kind: "preset", preset: "edge" }, needsProxy: [] },
		});
		expect(d.host.host.map((a) => a.slice(3).join(" "))).toEqual([
			"emu network speed 200:240",
			"emu network delay 175:225",
		]);
	});

	test("loss is reported as needing the proxy, never faked", async () => {
		const d = device();
		const { result } = await run(d, { kind: "preset", preset: "lossy" });
		expect(result.success && result.data.needsProxy).toEqual(["loss"]);
		const custom = await run(device(), { kind: "custom", lossPct: 5, downKbps: 100 });
		expect(custom.result.success && custom.result.data.needsProxy).toEqual(["loss"]);
	});

	test("custom with only latency leaves the speed unlimited", async () => {
		const d = device();
		await run(d, { kind: "custom", latencyMs: 300 });
		expect(d.host.host.map((a) => a.slice(3).join(" "))).toEqual([
			"emu network speed full",
			"emu network delay 150:150",
		]);
	});

	test("the console answering KO is an error even with exit 0", async () => {
		const d = device({ emu: "KO: invalid <speed> argument\n" });
		const { result } = await run(d, { kind: "preset", preset: "3g" });
		if (result.success) throw new Error("expected failure");
		expect(result.error.code).toBe("E_BAD_REQUEST");
		expect(result.error.message).toContain("invalid <speed>");
	});

	test("flap belongs to the scheduler", async () => {
		const d = device();
		const { result } = await run(d, { kind: "flap", upMs: 1, downMs: 1 });
		if (result.success) throw new Error("expected failure");
		expect(result.error.code).toBe("E_UNSUPPORTED");
		expect(result.error.message).toContain("scheduler");
		expect(d.host.shell).toEqual([]);
	});

	test("a physical device has no emulator console: unsupported, nothing run", async () => {
		const d = device();
		const { result } = await run(d, { kind: "offline" }, "R5CT1234567");
		if (result.success) throw new Error("expected failure");
		expect(result.error.code).toBe("E_UNSUPPORTED");
		expect(d.host.shell).toEqual([]);
		expect(d.host.host).toEqual([]);
	});

	test("an unreadable dumpsys keeps polling then times out", async () => {
		const d = device();
		d.host.shellRules.unshift({ match: "dumpsys connectivity", reply: "Can't find service: connectivity\n" });
		const { result } = await run(d, { kind: "offline" });
		if (result.success) throw new Error("expected failure");
		expect(result.error.code).toBe("E_TIMEOUT");
	});
});

describe("createAndroidNetwork: loss and faults through the lease proxy", () => {
	/** the device model plus a `settings` store for http_proxy */
	function proxied(opts: { proxy?: boolean; live?: boolean } = {}) {
		const d = device();
		let httpProxy = ":0";
		d.host.shellRules.unshift(
			{
				match: "settings put global http_proxy",
				reply: (cmd) => {
					httpProxy = cmd.split(" ").pop() ?? "";
					return "";
				},
			},
			{ match: "settings get global http_proxy", reply: () => `${httpProxy}\n` }
		);
		const proxy = fakeProxy(19_555, opts.live);
		const session = openAdbSession({ adb: "adb", serial: "emulator-5554", spawn: d.host.spawn });
		const net = createAndroidNetwork({
			session,
			exec: d.host.exec,
			adb: "adb",
			serial: "emulator-5554",
			clock: fakeClock(),
			...(opts.proxy === false ? {} : { proxy }),
		});
		return { d, proxy, net, httpProxy: () => httpProxy, close: () => session.close() };
	}

	test("argv", () => {
		expect(httpProxyPutArgv("10.0.2.2:19555")).toEqual(["settings", "put", "global", "http_proxy", "10.0.2.2:19555"]);
		expect(EMULATOR_HOST_ALIAS).toBe("10.0.2.2");
	});

	test("loss routes the system proxy at the host alias and the proxy applies only the loss", async () => {
		const r = proxied();
		const result = await r.net.network({ kind: "preset", preset: "lossy" });
		expect(result).toEqual({
			success: true,
			data: { online: true, condition: { kind: "preset", preset: "lossy" }, needsProxy: [] },
		});
		expect(r.httpProxy()).toBe("10.0.2.2:19555");
		expect(r.proxy.calls[0]).toMatchObject({ op: "ensure", conditions: { params: { lossPct: 10 }, faults: [] } });
		expect(r.d.host.host.map((a) => a.slice(3).join(" "))).toEqual([
			"emu network speed 1000:1000",
			"emu network delay 200:300",
		]);
		await r.close();
	});

	test("a condition without loss clears the system proxy again", async () => {
		const r = proxied();
		await r.net.network({ kind: "preset", preset: "lossy" });
		await r.net.network({ kind: "preset", preset: "3g" });
		expect(r.httpProxy()).toBe(":0");
		await r.close();
	});

	test("no proxy port: loss stays in needsProxy and the device proxy is untouched", async () => {
		const r = proxied({ proxy: false });
		const result = await r.net.network({ kind: "preset", preset: "lossy" });
		expect(result.success && result.data.needsProxy).toEqual(["loss"]);
		expect(r.httpProxy()).toBe(":0");
		await r.close();
	});

	test("faults route through the proxy and keep the current condition's loss", async () => {
		const r = proxied();
		await r.net.network({ kind: "online" });
		const faults = [{ match: "api.example.com", action: { kind: "status" as const, code: 503 } }];
		const result = await r.net.networkFaults(faults);
		expect(result.success && result.data.notes).toHaveLength(1);
		expect(r.httpProxy()).toBe("10.0.2.2:19555");
		expect(r.proxy.calls.at(-1)).toMatchObject({ op: "ensure", conditions: { faults } });
		await r.net.networkFaults([]);
		expect(r.httpProxy()).toBe(":0");
		await r.close();
	});

	test("faults without a proxy port are unsupported and roll back", async () => {
		const r = proxied({ proxy: false });
		const result = await r.net.networkFaults([{ match: "x", action: { kind: "reset" } }]);
		expect(!result.success && result.error.code).toBe("E_UNSUPPORTED");
		await r.close();
	});

	test("a proxy setting that does not read back is an error", async () => {
		const r = proxied();
		r.d.host.shellRules.unshift({ match: "settings get global http_proxy", reply: "null\n" });
		const result = await r.net.network({ kind: "preset", preset: "lossy" });
		expect(!result.success && result.error.code).toBe("E_IO");
		await r.close();
	});
});
