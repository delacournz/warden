import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "../exec";
import { openStore, type Store } from "../store";
import { createIosProvider, parseSimctlDevices, parseSimctlDeviceTypes, parseSimctlRuntimes } from "./ios";
import { SIMCTL_DEVICES_JSON, SIMCTL_DEVICETYPES_JSON, SIMCTL_RUNTIMES_JSON } from "./ios.fixture";
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
		env: {},
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
