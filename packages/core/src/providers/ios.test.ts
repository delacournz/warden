import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "../exec";
import { DEFAULT_SLIM_PROFILE, desiredLabels } from "../sims/slim.profile";
import { openStore, type Store } from "../store";
import {
	DEVICECTL_LIST_MIXED,
	DEVICECTL_LOCKSTATE_LOCKED,
	FAKE_IPAD_UDID,
	FAKE_IPHONE_UDID,
	FAKE_UNPAIRED_UDID,
} from "./devicectl.fixtures";
import { createIosProvider, deleteSim, parseSimctlDevices, parseSimctlDeviceTypes, parseSimctlRuntimes } from "./ios";
import { SIMCTL_DEVICES_JSON, SIMCTL_DEVICETYPES_JSON, SIMCTL_RUNTIMES_JSON, simctlDevicesJson } from "./ios.fixture";
import type { DeviceProvider } from "./provider.types";

let dir: string;
let store: Store;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-ios-"));
	store = openStore(join(dir, "warden.db"));
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

type Call = { cmd: string[]; timeoutMs?: number };

function fake(handlers: Array<[prefix: string, result: Partial<ExecResult>]>, calls: Call[] = []): Exec {
	return async (cmd, opts) => {
		const call: Call = { cmd: [...cmd] };
		if (opts?.timeoutMs !== undefined) call.timeoutMs = opts.timeoutMs;
		calls.push(call);
		const joined = cmd.join(" ");
		const hit = handlers.find(([prefix]) => joined.startsWith(prefix));
		if (!hit) return { exitCode: 127, stdout: "", stderr: `no handler for ${joined}` };
		return { exitCode: 0, stdout: "", stderr: "", ...hit[1] };
	};
}

function provider(exec: Exec): DeviceProvider {
	return createIosProvider({
		exec,
		store,
		env: { WARDEN_SIM_LAUNCHD_STORE_ROOT: dir },
		now: () => 42,
		owner: { kind: "agent", sessionId: "s1", cwd: "/" },
	});
}

describe("parseSimctlDevices", () => {
	test("flattens iOS runtimes, maps state, skips unavailable + non-iOS", () => {
		const result = parseSimctlDevices(SIMCTL_DEVICES_JSON);
		expect(result.success).toBe(true);
		if (!result.success) return;
		const byName = new Map(result.data.map((d) => [d.name, d]));
		expect([...byName.keys()].sort()).toEqual([
			"iPad Pro 13-inch (M5)",
			"iPhone 17",
			"iPhone 17 Pro",
			"warden-iphone-17-1",
			"warden-iphone-17-2",
		]);
		expect(byName.get("iPhone 17")).toEqual({
			platform: "ios",
			id: "978BAD6B-EEB8-4A54-9D5F-D17280D12AA5",
			name: "iPhone 17",
			state: "booted",
			wardenCreated: false,
			profile: "iphone-17",
			runtime: "iOS-26-5",
		});
		expect(byName.get("warden-iphone-17-1")?.state).toBe("shutdown");
		expect(byName.get("warden-iphone-17-2")?.state).toBe("booting");
		expect(byName.get("iPhone 17 Pro")?.profile).toBe("iphone-17-pro");
		for (const d of result.data) expect(d.wardenCreated).toBe(false);
	});

	test("a sim still Shutting Down is reported shut down, so a claim boots it instead of reusing it (16-1)", () => {
		const json = simctlDevicesJson({
			"iOS-26-5": [{ udid: "S", name: "warden-iphone-17-1", state: "Shutting Down" }],
		});
		const result = parseSimctlDevices(json);
		expect(result.success && result.data.map((d) => d.state)).toEqual(["shutdown"]);
	});

	test("marks golden devices", () => {
		const json = simctlDevicesJson({
			"iOS-26-5": [
				{ udid: "G", name: "warden-golden-iphone-17-abc123def0", state: "Shutdown" },
				{ udid: "P", name: "warden-iphone-17-1", state: "Shutdown" },
			],
		});
		const result = parseSimctlDevices(json);
		expect(result.success && result.data.map((d) => d.golden)).toEqual([true, undefined]);
	});

	test("invalid JSON or shape → err", () => {
		expect(parseSimctlDevices("nope").success).toBe(false);
		expect(
			parseSimctlDevices(JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [{ name: 1 }] } }))
				.success
		).toBe(false);
	});
});

describe("parseSimctlRuntimes / DeviceTypes", () => {
	test("runtimes: iOS + available only, newest first", () => {
		const result = parseSimctlRuntimes(SIMCTL_RUNTIMES_JSON);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.map((r) => r.identifier)).toEqual([
			"com.apple.CoreSimulator.SimRuntime.iOS-26-5",
			"com.apple.CoreSimulator.SimRuntime.iOS-26-3",
			"com.apple.CoreSimulator.SimRuntime.iOS-26-1",
		]);
		expect(result.data.every((r) => typeof r.build === "string")).toBe(true);
	});

	test("device types parsed", () => {
		const result = parseSimctlDeviceTypes(SIMCTL_DEVICETYPES_JSON);
		expect(result.success && result.data.map((t) => t.name)).toEqual([
			"iPhone 17 Pro",
			"iPhone 17",
			"iPad Pro 13-inch (M5)",
		]);
	});
});

describe("createIosProvider", () => {
	test("inventory runs simctl list devices available -j", async () => {
		const calls: Call[] = [];
		const p = provider(fake([["xcrun simctl list devices available -j", { stdout: SIMCTL_DEVICES_JSON }]], calls));
		const result = await p.inventory();
		expect(result.success && result.data.length).toBe(5);
		expect(calls[0]?.cmd).toEqual(["xcrun", "simctl", "list", "devices", "available", "-j"]);
	});

	test("inventory surfaces exec failure", async () => {
		const p = provider(fake([["xcrun simctl list", { exitCode: 1, stderr: "CoreSimulator is sad" }]]));
		const result = await p.inventory();
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toContain("CoreSimulator is sad");
	});

	test("create resolves profile → device type, latest runtime, records device", async () => {
		const calls: Call[] = [];
		const p = provider(
			fake(
				[
					["xcrun simctl list devicetypes -j", { stdout: SIMCTL_DEVICETYPES_JSON }],
					["xcrun simctl list runtimes -j", { stdout: SIMCTL_RUNTIMES_JSON }],
					["xcrun simctl create", { stdout: "NEW-UDID-1\n" }],
				],
				calls
			)
		);
		const result = await p.create("warden-iphone-17-3", "iphone-17");
		expect(result).toEqual({
			success: true,
			data: {
				platform: "ios",
				id: "NEW-UDID-1",
				name: "warden-iphone-17-3",
				state: "shutdown",
				wardenCreated: true,
				profile: "iphone-17",
				runtime: "iOS-26-5",
			},
		});
		expect(calls.at(-1)?.cmd).toEqual([
			"xcrun",
			"simctl",
			"create",
			"warden-iphone-17-3",
			"com.apple.CoreSimulator.SimDeviceType.iPhone-17",
			"com.apple.CoreSimulator.SimRuntime.iOS-26-5",
		]);
		expect(store.listDevices("ios")).toEqual([
			{
				platform: "ios",
				id: "NEW-UDID-1",
				name: "warden-iphone-17-3",
				profile: "iphone-17",
				runtime: "iOS-26-5",
				createdAt: 42,
				lastUsedAt: 42,
			},
		]);
	});

	test("create clones via the clone strategy when given, records the device", async () => {
		const calls: Call[] = [];
		const clones: string[][] = [];
		const p = createIosProvider(
			{
				exec: fake([], calls),
				store,
				env: { WARDEN_SIM_LAUNCHD_STORE_ROOT: dir },
				now: () => 42,
				owner: { kind: "agent", sessionId: "s1", cwd: "/" },
			},
			{
				clone: async (name, profile, runtime) => {
					clones.push([name, profile, runtime ?? "-"]);
					return { success: true, data: { udid: "CLONED", runtime: "iOS-26-5" } };
				},
			}
		);
		const result = await p.create("warden-iphone-17-3", "iphone-17");
		expect(result).toEqual({
			success: true,
			data: {
				platform: "ios",
				id: "CLONED",
				name: "warden-iphone-17-3",
				state: "shutdown",
				wardenCreated: true,
				profile: "iphone-17",
				runtime: "iOS-26-5",
			},
		});
		expect(clones).toEqual([["warden-iphone-17-3", "iphone-17", "-"]]);
		expect(calls).toEqual([]);
		expect(store.listDevices("ios").map((d) => d.id)).toEqual(["CLONED"]);
	});

	test("clone failure falls back to simctl create and logs why", async () => {
		const logs: string[] = [];
		const p = createIosProvider(
			{
				exec: fake([
					["xcrun simctl list devicetypes -j", { stdout: SIMCTL_DEVICETYPES_JSON }],
					["xcrun simctl list runtimes -j", { stdout: SIMCTL_RUNTIMES_JSON }],
					["xcrun simctl create", { stdout: "FRESH\n" }],
				]),
				store,
				env: { WARDEN_SIM_LAUNCHD_STORE_ROOT: dir },
				now: () => 42,
				owner: { kind: "agent", sessionId: "s1", cwd: "/" },
				log: (line) => logs.push(line),
			},
			{ clone: async () => ({ success: false, error: "no xcodebuild" }) }
		);
		const result = await p.create("warden-iphone-17-3", "iphone-17");
		expect(result.success && result.data.id).toBe("FRESH");
		expect(logs.join("\n")).toContain("no xcodebuild");
	});

	test("create honours explicit runtime (suffix or version)", async () => {
		const calls: Call[] = [];
		const handlers: Array<[string, Partial<ExecResult>]> = [
			["xcrun simctl list devicetypes -j", { stdout: SIMCTL_DEVICETYPES_JSON }],
			["xcrun simctl list runtimes -j", { stdout: SIMCTL_RUNTIMES_JSON }],
			["xcrun simctl create", { stdout: "U2" }],
		];
		const p = provider(fake(handlers, calls));
		expect((await p.create("a", "iphone-17", "iOS-26-1")).success).toBe(true);
		expect(calls.at(-1)?.cmd.at(-1)).toBe("com.apple.CoreSimulator.SimRuntime.iOS-26-1");
		expect((await p.create("b", "iphone-17", "26.3")).success).toBe(true);
		expect(calls.at(-1)?.cmd.at(-1)).toBe("com.apple.CoreSimulator.SimRuntime.iOS-26-3");
	});

	test("create skips runtimes that don't support the device type", async () => {
		const calls: Call[] = [];
		const p = provider(
			fake(
				[
					["xcrun simctl list devicetypes -j", { stdout: SIMCTL_DEVICETYPES_JSON }],
					["xcrun simctl list runtimes -j", { stdout: SIMCTL_RUNTIMES_JSON }],
					["xcrun simctl create", { stdout: "U3" }],
				],
				calls
			)
		);
		const result = await p.create("x", "iphone-17-pro", "26.3");
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toContain("26.3");
	});

	test("create: unknown profile / runtime → err listing options", async () => {
		const p = provider(
			fake([
				["xcrun simctl list devicetypes -j", { stdout: SIMCTL_DEVICETYPES_JSON }],
				["xcrun simctl list runtimes -j", { stdout: SIMCTL_RUNTIMES_JSON }],
			])
		);
		const badProfile = await p.create("x", "iphone-99");
		expect(badProfile.success).toBe(false);
		if (!badProfile.success) expect(badProfile.error).toContain("iphone-17");
		const badRuntime = await p.create("x", "iphone-17", "iOS-19-0");
		expect(badRuntime.success).toBe(false);
		if (!badRuntime.success) expect(badRuntime.error).toContain("iOS-26-5");
		expect(store.listDevices()).toEqual([]);
	});

	test("boot is headless simctl boot; already booted = ok", async () => {
		const calls: Call[] = [];
		const p = provider(fake([["xcrun simctl boot U1", {}]], calls));
		expect(await p.boot("U1")).toEqual({ success: true, data: undefined });
		expect(calls[0]?.cmd).toEqual(["xcrun", "simctl", "boot", "U1"]);

		const already = provider(
			fake([
				[
					"xcrun simctl boot",
					{
						exitCode: 149,
						stderr:
							"An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):\nUnable to boot device in current state: Booted",
					},
				],
			])
		);
		expect((await already.boot("U1")).success).toBe(true);

		const broken = provider(fake([["xcrun simctl boot", { exitCode: 1, stderr: "Invalid device: U1" }]]));
		const result = await broken.boot("U1");
		expect(result.success).toBe(false);
	});

	test("boot of a sim still Shutting Down waits for the shutdown to finish, then boots (16-1)", async () => {
		const calls: Call[] = [];
		let boots = 0;
		const exec: Exec = async (cmd) => {
			calls.push({ cmd: [...cmd] });
			if (cmd.join(" ") !== "xcrun simctl boot U1") return { exitCode: 127, stdout: "", stderr: "unexpected" };
			return ++boots < 3
				? { exitCode: 149, stdout: "", stderr: "Unable to boot device in current state: Shutting Down" }
				: { exitCode: 0, stdout: "", stderr: "" };
		};
		const slept: number[] = [];
		const p = createIosProvider(
			{
				exec,
				store,
				env: { WARDEN_SIM_LAUNCHD_STORE_ROOT: dir },
				now: () => 42,
				owner: { kind: "agent", sessionId: "s1", cwd: "/" },
			},
			{ sleep: async (ms) => void slept.push(ms) }
		);
		expect(await p.boot("U1")).toEqual({ success: true, data: undefined });
		expect(boots).toBe(3);
		expect(slept).toEqual([500, 500]);
	});

	test("boot gives up when the sim stays Shutting Down", async () => {
		const exec: Exec = async () => ({
			exitCode: 149,
			stdout: "",
			stderr: "Unable to boot device in current state: Shutting Down",
		});
		let slept = 0;
		const p = createIosProvider(
			{
				exec,
				store,
				env: { WARDEN_SIM_LAUNCHD_STORE_ROOT: dir },
				now: () => 42,
				owner: { kind: "agent", sessionId: "s1", cwd: "/" },
			},
			{
				sleep: async (ms) => {
					slept += ms;
				},
			}
		);
		const result = await p.boot("U1");
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toContain("Shutting Down");
		expect(slept).toBe(30_000);
	});

	test("waitReady uses bootstatus -b with timeout", async () => {
		const calls: Call[] = [];
		const p = provider(fake([["xcrun simctl bootstatus U1 -b", {}]], calls));
		expect((await p.waitReady("U1", 5_000)).success).toBe(true);
		expect(calls[0]).toEqual({ cmd: ["xcrun", "simctl", "bootstatus", "U1", "-b"], timeoutMs: 5_000 });

		const timeout = provider(fake([["xcrun simctl bootstatus", { exitCode: 143 }]]));
		expect((await timeout.waitReady("U1", 10)).success).toBe(false);
	});

	test("shutdown; already shut down = ok", async () => {
		const calls: Call[] = [];
		const p = provider(fake([["xcrun simctl shutdown U1", {}]], calls));
		expect((await p.shutdown("U1")).success).toBe(true);
		expect(calls[0]?.cmd).toEqual(["xcrun", "simctl", "shutdown", "U1"]);

		const already = provider(
			fake([
				["xcrun simctl shutdown", { exitCode: 149, stderr: "Unable to shutdown device in current state: Shutdown" }],
			])
		);
		expect((await already.shutdown("U1")).success).toBe(true);
		const broken = provider(fake([["xcrun simctl shutdown", { exitCode: 1, stderr: "Invalid device" }]]));
		expect((await broken.shutdown("U1")).success).toBe(false);
	});
});

describe("createIosProvider timeouts (16-11)", () => {
	const okAll: Exec = async (cmd) => ({
		exitCode: 0,
		stdout: cmd.includes("devicetypes")
			? SIMCTL_DEVICETYPES_JSON
			: cmd.includes("runtimes")
				? SIMCTL_RUNTIMES_JSON
				: cmd.includes("devices")
					? SIMCTL_DEVICES_JSON
					: "NEW\n",
		stderr: "",
	});

	test("every simctl call carries a default timeout: list 30 s, create/boot 120 s, shutdown 60 s", async () => {
		const timeouts = new Map<string, number | undefined>();
		const exec: Exec = (cmd, opts) => {
			timeouts.set(cmd.slice(cmd[1] === "devicectl" ? 1 : 2, 4).join(" "), opts?.timeoutMs);
			return okAll(cmd, opts);
		};
		const p = provider(exec);
		await p.inventory();
		await p.create("warden-iphone-17-3", "iphone-17");
		await p.boot("U1");
		await p.shutdown("U1");
		expect(Object.fromEntries(timeouts)).toEqual({
			"list devices": 30_000,
			"list devicetypes": 30_000,
			"list runtimes": 30_000,
			"create warden-iphone-17-3": 120_000,
			"boot U1": 120_000,
			"shutdown U1": 60_000,
		});
	});

	test("a simctl that never returns is an error once its timeout fires, not a hung claim", async () => {
		const hung: Exec = () => new Promise<ExecResult>(() => {});
		const fired: number[] = [];
		const p = createIosProvider(
			{
				exec: hung,
				store,
				env: { WARDEN_SIM_LAUNCHD_STORE_ROOT: dir },
				now: () => 42,
				owner: { kind: "agent", sessionId: "s1", cwd: "/" },
				timer: (ms) => {
					fired.push(ms);
					return { promise: Promise.resolve(), cancel: () => {} };
				},
			},
			{ sleep: async () => {} }
		);
		expect(await p.boot("U1")).toEqual({
			success: false,
			error: "`xcrun simctl boot U1` did not finish within 120s",
		});
		const listed = await p.inventory();
		expect(listed.success).toBe(false);
		const down = await p.shutdown("U1");
		expect(!down.success && down.error).toContain("did not finish within 60s");
		const created = await p.create("warden-iphone-17-3", "iphone-17");
		expect(!created.success && created.error).toContain("did not finish within 30s");
		expect(fired).toEqual([120_000, 30_000, 60_000, 30_000, 30_000]);
	});
});

describe("createIosProvider bootReady (16-15)", () => {
	function bootProvider(exec: Exec) {
		return createIosProvider(
			{
				exec,
				store,
				env: { WARDEN_SIM_LAUNCHD_STORE_ROOT: dir },
				now: () => 42,
				owner: { kind: "agent", sessionId: "s1", cwd: "/" },
			},
			{ sleep: async () => {} }
		);
	}
	const run = (p: DeviceProvider, id: string) => {
		if (!p.bootReady) throw new Error("ios provider has bootReady");
		return p.bootReady(id, 300_000);
	};

	test("a shut-down sim: bootstatus -b alone boots it and waits (no separate simctl boot)", async () => {
		const calls: Call[] = [];
		const p = bootProvider(fake([["xcrun simctl bootstatus U1 -b", {}]], calls));
		expect(await run(p, "U1")).toEqual({ kind: "ready" });
		expect(calls).toEqual([{ cmd: ["xcrun", "simctl", "bootstatus", "U1", "-b"], timeoutMs: 300_000 }]);
	});

	test("bootstatus refuses the state (Shutting Down) → simctl boot waits it out, then bootstatus again", async () => {
		const calls: Call[] = [];
		let statuses = 0;
		const exec: Exec = async (cmd, opts) => {
			calls.push({ cmd: [...cmd], ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
			if (cmd[2] === "bootstatus" && ++statuses === 1) {
				return { exitCode: 149, stdout: "", stderr: "Unable to boot device in current state: Shutting Down" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		};
		expect(await run(bootProvider(exec), "U1")).toEqual({ kind: "ready" });
		expect(calls.map((c) => c.cmd[2])).toEqual(["bootstatus", "boot", "bootstatus"]);
	});

	test("a device simctl cannot boot is a boot failure, not an unready device", async () => {
		const p = bootProvider(
			fake([
				["xcrun simctl bootstatus", { exitCode: 1, stderr: "Invalid device: U1" }],
				["xcrun simctl boot", { exitCode: 1, stderr: "Invalid device: U1" }],
			])
		);
		const result = await run(p, "U1");
		expect(result.kind).toBe("boot-failed");
		if (result.kind === "boot-failed") expect(result.error).toContain("Invalid device");
	});

	test("bootstatus timing out is not ready, with no extra boot", async () => {
		const calls: Call[] = [];
		const p = bootProvider(fake([["xcrun simctl bootstatus", { exitCode: 143 }]], calls));
		const result = await run(p, "U1");
		expect(result.kind).toBe("not-ready");
		expect(calls.map((c) => c.cmd[2])).toEqual(["bootstatus"]);
	});

	test("the fallback's second bootstatus gets only what is left of the budget (ios-claim-path-R5)", async () => {
		const calls: Call[] = [];
		let clock = 0;
		let statuses = 0;
		const exec: Exec = async (cmd, opts) => {
			calls.push({ cmd: [...cmd], ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
			if (cmd[2] === "bootstatus" && ++statuses === 1) {
				clock += 290_000; // bootstatus gives up late, close to the whole budget
				return { exitCode: 149, stdout: "", stderr: "Unable to boot device in current state: Shutting Down" };
			}
			if (cmd[2] === "boot") clock += 4_000;
			return { exitCode: 0, stdout: "", stderr: "" };
		};
		const p = createIosProvider(
			{
				exec,
				store,
				env: { WARDEN_SIM_LAUNCHD_STORE_ROOT: dir },
				now: () => clock,
				owner: { kind: "agent", sessionId: "s1", cwd: "/" },
			},
			{ sleep: async () => {} }
		);
		expect(await run(p, "U1")).toEqual({ kind: "ready" });
		const second = calls.filter((c) => c.cmd[2] === "bootstatus")[1];
		expect(second?.timeoutMs).toBe(6_000);
	});

	test("no budget left after the fallback boot: not ready, no second wait (ios-claim-path-R5)", async () => {
		const calls: Call[] = [];
		let clock = 0;
		const exec: Exec = async (cmd, opts) => {
			calls.push({ cmd: [...cmd], ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
			if (cmd[2] === "bootstatus") {
				clock += 300_000;
				return { exitCode: 149, stdout: "", stderr: "Unable to boot device in current state: Shutting Down" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		};
		const p = createIosProvider(
			{
				exec,
				store,
				env: { WARDEN_SIM_LAUNCHD_STORE_ROOT: dir },
				now: () => clock,
				owner: { kind: "agent", sessionId: "s1", cwd: "/" },
			},
			{ sleep: async () => {} }
		);
		const result = await run(p, "U1");
		expect(result.kind).toBe("not-ready");
		expect(calls.map((c) => c.cmd[2])).toEqual(["bootstatus", "boot"]);
	});

	test("probeBooted is the one-spawn warm probe", async () => {
		const calls: Call[] = [];
		const p = bootProvider(
			fake(
				[["xcrun simctl spawn U1 launchctl list", { stdout: "412\t0\tUIKitApplication:com.apple.springboard[x]" }]],
				calls
			)
		);
		expect(await p.probeBooted?.("U1")).toEqual({ success: true, data: undefined });
		expect(calls.map((c) => c.cmd.join(" "))).toEqual(["xcrun simctl spawn U1 launchctl list"]);
	});
});

describe("deleteSim", () => {
	test("shuts the sim down (already-shutdown is fine) then deletes it", async () => {
		const calls: Call[] = [];
		const exec = fake(
			[
				["xcrun simctl shutdown", { exitCode: 1, stderr: "Unable to shutdown device in current state: Shutdown" }],
				["xcrun simctl delete", {}],
			],
			calls
		);
		expect(await deleteSim(exec, "U1")).toEqual({ success: true, data: undefined });
		expect(calls.map((c) => c.cmd.join(" "))).toEqual(["xcrun simctl shutdown U1", "xcrun simctl delete U1"]);
	});

	test("skips the shutdown when told to (an unavailable sim can't be shut down)", async () => {
		const calls: Call[] = [];
		const exec = fake([["xcrun simctl delete", {}]], calls);
		expect((await deleteSim(exec, "U1", { shutdown: false })).success).toBe(true);
		expect(calls.map((c) => c.cmd.join(" "))).toEqual(["xcrun simctl delete U1"]);
	});

	test("reports a failed delete", async () => {
		const exec = fake([
			["xcrun simctl shutdown", {}],
			["xcrun simctl delete", { exitCode: 1, stderr: "Invalid device: U1" }],
		]);
		const result = await deleteSim(exec, "U1");
		expect(result.success).toBe(false);
	});
});

describe("createIosProvider slim (SLIM-2)", () => {
	const owner = { kind: "agent", sessionId: "s1", cwd: "/" } as const;
	const printed = (labels: Iterable<string>): string =>
		`disabled services = {\n${[...labels].map((l) => `\t"${l}" => disabled`).join("\n")}\n}\n`;

	function slimProvider(exec: Exec, options: Parameters<typeof createIosProvider>[1] = {}): DeviceProvider {
		return createIosProvider(
			{
				exec,
				store,
				env: { WARDEN_SIM_LAUNCHD_STORE_ROOT: dir },
				now: () => 42,
				owner,
				log: (line) => logs.push(line),
			},
			{
				clone: async () => ({ success: true, data: { udid: "CLONED", runtime: runtimeOfClone } }),
				sleep: async () => {},
				...options,
			}
		);
	}
	let logs: string[];
	let runtimeOfClone: string;
	beforeEach(() => {
		logs = [];
		runtimeOfClone = "iOS-26-5";
	});

	const storeFile = () => join(dir, "com.apple.CoreSimulator.SimDevice.CLONED", "disabled.plist");

	test("create writes the override store right after the clone, with zero simctl calls", async () => {
		const calls: Call[] = [];
		const p = slimProvider(fake([], calls));
		await p.create("warden-iphone-17-9", "iphone-17");
		expect(existsSync(storeFile())).toBe(true);
		expect(calls).toEqual([]);
	});

	test("an older runtime is not written offline", async () => {
		runtimeOfClone = "iOS-18-4";
		const p = slimProvider(fake([]));
		await p.create("warden-iphone-17-9", "iphone-17");
		expect(existsSync(storeFile())).toBe(false);
	});

	test("slim: false writes nothing and afterReady does nothing", async () => {
		const calls: Call[] = [];
		const p = slimProvider(fake([], calls), { slim: false });
		await p.create("warden-iphone-17-9", "iphone-17");
		await p.afterReady?.("CLONED");
		expect(existsSync(storeFile())).toBe(false);
		expect(calls).toEqual([]);
		expect(store.listDevices("ios")[0]?.slimmedAt).toBeUndefined();
	});

	test("golden sims are never slimmed", async () => {
		store.recordDevice(
			{ platform: "ios", id: "G1", name: "warden-golden-iphone-17-abc", profile: "iphone-17", runtime: "iOS-26-5" },
			1
		);
		const calls: Call[] = [];
		const p = slimProvider(fake([], calls));
		await p.prepareBoot?.("G1");
		await p.afterReady?.("G1");
		expect(calls).toEqual([]);
	});

	test("afterReady with every override in place records slimmedAt and spawns only print-disabled", async () => {
		const calls: Call[] = [];
		const p = slimProvider(
			fake(
				[
					[
						"xcrun simctl spawn CLONED launchctl print-disabled system",
						{ stdout: printed(desiredLabels(DEFAULT_SLIM_PROFILE)) },
					],
				],
				calls
			)
		);
		await p.create("warden-iphone-17-9", "iphone-17");
		await p.afterReady?.("CLONED");
		expect(calls.map((c) => c.cmd.join(" "))).toEqual(["xcrun simctl spawn CLONED launchctl print-disabled system"]);
		expect(store.listDevices("ios")[0]?.slimmedAt).toBe(42);
		expect(logs).toEqual([]);
	});

	test("afterReady with missing overrides logs and slims live, then records slimmedAt", async () => {
		const desired = [...desiredLabels(DEFAULT_SLIM_PROFILE)].sort();
		const calls: string[] = [];
		let enabledAll = false;
		const exec: Exec = async (cmd) => {
			const joined = cmd.join(" ");
			calls.push(joined);
			if (joined.endsWith("print-disabled system")) {
				return { exitCode: 0, stdout: printed(enabledAll ? desired : desired.slice(3)), stderr: "" };
			}
			if (joined.includes(" disable ")) enabledAll = true;
			return { exitCode: 0, stdout: "PID\tStatus\tLabel\n", stderr: "" };
		};
		const p = slimProvider(exec);
		await p.create("warden-iphone-17-9", "iphone-17");
		await p.afterReady?.("CLONED");
		const total = desired.length;
		expect(logs).toContain(`CLONED came up with ${total - 3}/${total} overrides, fixing live`);
		expect(calls.some((c) => c.includes(" disable "))).toBe(true);
		expect(store.listDevices("ios")[0]?.slimmedAt).toBe(42);
	});

	test("a failed live fallback does not record slimmedAt", async () => {
		const p = slimProvider(
			fake([
				["xcrun simctl spawn CLONED launchctl print-disabled system", { stdout: printed([]) }],
				["xcrun simctl spawn CLONED launchctl list", { exitCode: 1, stderr: "nope" }],
			])
		);
		await p.create("warden-iphone-17-9", "iphone-17");
		await p.afterReady?.("CLONED");
		expect(store.listDevices("ios")[0]?.slimmedAt).toBeUndefined();
		expect(logs.some((l) => l.includes("live slim failed"))).toBe(true);
	});

	test("biometrics profile: the clone is made for the plain profile, recorded +bio, and enrolled after every boot", async () => {
		const cloned: string[] = [];
		const calls: Call[] = [];
		const p = createIosProvider(
			{
				exec: fake(
					[["xcrun simctl spawn CLONED notifyutil", { stdout: "com.apple.BiometricKit.enrollmentChanged 1\n" }]],
					calls
				),
				store,
				env: { WARDEN_SIM_LAUNCHD_STORE_ROOT: dir },
				now: () => 42,
				owner,
				log: (line) => logs.push(line),
			},
			{
				clone: async (_name, profile) => {
					cloned.push(profile);
					return { success: true, data: { udid: "CLONED", runtime: "iOS-26-5" } };
				},
				slim: false,
				sleep: async () => {},
			}
		);
		const created = await p.create("warden-iphone-17+bio-1", "iphone-17+bio");
		expect(created.success && created.data.profile).toBe("iphone-17+bio");
		expect(cloned).toEqual(["iphone-17"]);
		expect(store.listDevices("ios")[0]?.profile).toBe("iphone-17+bio");
		await p.afterReady?.("CLONED");
		expect(calls.map((c) => c.cmd.join(" "))).toEqual([
			"xcrun simctl spawn CLONED notifyutil -s com.apple.BiometricKit.enrollmentChanged 1",
			"xcrun simctl spawn CLONED notifyutil -p com.apple.BiometricKit.enrollmentChanged",
			"xcrun simctl spawn CLONED notifyutil -g com.apple.BiometricKit.enrollmentChanged",
		]);
	});

	test("biometrics enroll is retried until a read-back shows state 1 (a write right after boot can be dropped)", async () => {
		const sleeps: number[] = [];
		let reads = 0;
		const exec: Exec = async (cmd) => {
			if (cmd.join(" ").endsWith("notifyutil -g com.apple.BiometricKit.enrollmentChanged")) {
				reads += 1;
				return {
					exitCode: 0,
					stdout: `com.apple.BiometricKit.enrollmentChanged ${reads >= 3 ? 1 : 0}\n`,
					stderr: "",
				};
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		};
		const p = slimProvider(exec, {
			slim: false,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		await p.create("warden-iphone-17+bio-1", "iphone-17+bio");
		await p.afterReady?.("CLONED");
		expect(reads).toBe(3);
		expect(sleeps).toHaveLength(2);
		expect(logs.some((l) => l.includes("biometrics"))).toBe(false);
	});

	test("biometrics enroll that never reads back 1 is logged after a bounded number of attempts", async () => {
		const calls: Call[] = [];
		const p = slimProvider(
			fake(
				[["xcrun simctl spawn CLONED notifyutil", { stdout: "com.apple.BiometricKit.enrollmentChanged 0\n" }]],
				calls
			),
			{ slim: false }
		);
		await p.create("warden-iphone-17+bio-9", "iphone-17+bio");
		await p.afterReady?.("CLONED");
		const reads = calls.filter((c) => c.cmd.includes("-g")).length;
		expect(reads).toBeGreaterThan(1);
		expect(reads).toBeLessThanOrEqual(20);
		expect(logs.some((l) => l.includes("biometrics enroll did not take"))).toBe(true);
	});

	test("a plain profile and a device warden has no record of are never enrolled", async () => {
		const calls: Call[] = [];
		const p = slimProvider(fake([], calls), { slim: false });
		await p.create("warden-iphone-17-9", "iphone-17");
		await p.afterReady?.("CLONED");
		await p.afterReady?.("FOREIGN");
		expect(calls).toEqual([]);
	});

	test("a failed enrollment is logged, not fatal", async () => {
		const p = slimProvider(fake([["xcrun simctl spawn CLONED notifyutil", { exitCode: 1, stderr: "nope" }]]), {
			slim: false,
		});
		await p.create("warden-iphone-17+bio-9", "iphone-17+bio");
		await p.afterReady?.("CLONED");
		expect(logs.some((l) => l.includes("biometrics enroll failed"))).toBe(true);
	});
});

describe("createIosProvider physical iPhones (PHY-6.5)", () => {
	const physicalProvider = (exec: Exec): DeviceProvider =>
		createIosProvider(
			{
				exec,
				store,
				env: { WARDEN_SIM_LAUNCHD_STORE_ROOT: dir },
				now: () => 42,
				owner: { kind: "agent", sessionId: "s1", cwd: "/" },
			},
			{ physical: true }
		);
	const SIMS: [string, Partial<ExecResult>] = [
		"xcrun simctl list devices available -j",
		{ stdout: SIMCTL_DEVICES_JSON },
	];
	const LIST: [string, Partial<ExecResult>] = ["xcrun devicectl list devices", { stdout: DEVICECTL_LIST_MIXED }];

	test("inventory runs no devicectl unless physical is on", async () => {
		const calls: Call[] = [];
		const result = await provider(fake([SIMS, LIST], calls)).inventory();
		expect(result.success && result.data.some((d) => d.physical)).toBe(false);
		expect(calls.map((c) => c.cmd[1])).toEqual(["simctl"]);
	});

	test("inventory lists simulators and physical phones together", async () => {
		const result = await physicalProvider(fake([SIMS, LIST])).inventory();
		expect(result.success).toBe(true);
		if (!result.success) return;
		const phones = result.data.filter((d) => d.physical);
		expect(phones.map((d) => d.id)).toEqual([FAKE_IPHONE_UDID, FAKE_IPAD_UDID, FAKE_UNPAIRED_UDID]);
		expect(result.data.filter((d) => !d.physical).length).toBeGreaterThan(0);
	});

	test.each([
		["devicectl fails", { exitCode: 1, stderr: "boom" }],
		["devicectl prints garbage", { stdout: "not json" }],
		["xcrun cannot find devicectl", { exitCode: 127, stderr: "xcrun: error" }],
	] as Array<[string, Partial<ExecResult>]>)("sim inventory is unaffected when %s", async (_name, failure) => {
		const result = await physicalProvider(fake([SIMS, ["xcrun devicectl list devices", failure]])).inventory();
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.some((d) => d.physical)).toBe(false);
		expect(result.data.map((d) => d.name)).toContain("iPhone 17");
	});

	test("a failing simctl still fails the inventory", async () => {
		const result = await physicalProvider(
			fake([["xcrun simctl list", { exitCode: 1, stderr: "x" }], LIST])
		).inventory();
		expect(result.success).toBe(false);
	});

	test("a phone never reaches the store devices table", async () => {
		await physicalProvider(fake([SIMS, LIST])).inventory();
		expect(store.listDevices("ios")).toEqual([]);
	});

	test("boot, bootReady and shutdown refuse a phone and run nothing", async () => {
		const calls: Call[] = [];
		const p = physicalProvider(fake([SIMS, LIST], calls));
		const boot = await p.boot(FAKE_IPHONE_UDID);
		const shutdown = await p.shutdown(FAKE_IPHONE_UDID);
		const ready = await p.bootReady?.(FAKE_IPHONE_UDID, 1000);
		expect(boot.success).toBe(false);
		expect(!boot.success && boot.error).toContain("physical");
		expect(shutdown.success).toBe(false);
		expect(!shutdown.success && shutdown.error).toContain("physical");
		expect(ready?.kind).toBe("boot-failed");
		expect(calls).toEqual([]);
	});

	test("probe, probeBooted, verifyWarm and waitReady on a phone use devicectl lockState, never simctl", async () => {
		const calls: Call[] = [];
		const p = provider(
			fake([["xcrun devicectl device info lockState", { stdout: DEVICECTL_LOCKSTATE_LOCKED }]], calls)
		);
		expect((await p.probe?.(FAKE_IPHONE_UDID))?.success).toBe(true);
		expect((await p.probeBooted?.(FAKE_IPHONE_UDID))?.success).toBe(true);
		expect((await p.verifyWarm?.(FAKE_IPHONE_UDID))?.success).toBe(true);
		expect((await p.waitReady(FAKE_IPHONE_UDID, 1000)).success).toBe(true);
		expect(calls.length).toBe(4);
		expect(calls.every((c) => c.cmd.slice(0, 5).join(" ") === "xcrun devicectl device info lockState")).toBe(true);
	});

	test("a phone devicectl cannot reach fails its probe", async () => {
		const p = physicalProvider(
			fake([["xcrun devicectl device info lockState", { exitCode: 1, stderr: "not connected" }]])
		);
		expect((await p.probe?.(FAKE_IPHONE_UDID))?.success).toBe(false);
	});

	test("prepareBoot and afterReady leave a phone alone", async () => {
		const calls: Call[] = [];
		const p = physicalProvider(fake([], calls));
		await p.prepareBoot?.(FAKE_IPHONE_UDID);
		await p.afterReady?.(FAKE_IPHONE_UDID);
		expect(calls).toEqual([]);
	});
});
