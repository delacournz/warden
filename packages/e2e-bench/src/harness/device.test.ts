import { describe, expect, test } from "bun:test";
import { BENCH_LEASE_TTL, claimDevice, deviceInfo, heartbeatDevice, parseClaim, releaseDevice } from "./device";
import { fakeExec } from "./exec";

const CLAIM = JSON.stringify({
	leases: [{ leaseId: "L1", udid: "U1", name: "iPhone 16" }],
	udids: ["U1"],
	reclaimed: false,
});
const SIMCTL = JSON.stringify({
	devices: {
		"com.apple.CoreSimulator.SimRuntime.iOS-17-5": [{ udid: "OLD", name: "iPhone 15" }],
		"com.apple.CoreSimulator.SimRuntime.iOS-18-2": [{ udid: "U1", name: "iPhone 16", state: "Booted" }],
	},
});
const base = { platform: "ios" as const, cliPath: "/cli.ts", repoRoot: "/repo", log: () => undefined };

describe("claimDevice", () => {
	test("with udid: no claim", async () => {
		const exec = fakeExec();
		const r = await claimDevice(exec, { ...base, udid: "MINE" });
		expect(r).toEqual({ success: true, data: { udid: "MINE" } });
		expect(exec.calls).toHaveLength(0);
	});
	test("claims via warden cli and parses the lease", async () => {
		const exec = fakeExec([{ cmd: process.execPath, result: { stdout: CLAIM } }]);
		const r = await claimDevice(exec, base);
		expect(r).toEqual({ success: true, data: { udid: "U1", leaseId: "L1", name: "iPhone 16" } });
		expect(exec.calls[0]?.args).toEqual(["/cli.ts", "claim", "ios", "--ttl", "4h", "--label", "bench", "--json"]);
		expect(BENCH_LEASE_TTL).toBe("4h");
	});
	test("failure and garbage are errors", async () => {
		const bad = await claimDevice(
			fakeExec([{ cmd: process.execPath, result: { code: 1, stderr: "no devices" } }]),
			base
		);
		expect(bad.success).toBe(false);
		const junk = await claimDevice(fakeExec([{ cmd: process.execPath, result: { stdout: "nope" } }]), base);
		expect(junk.success).toBe(false);
	});
});

describe("parseClaim", () => {
	test("rejects missing fields", () => {
		expect(parseClaim(JSON.stringify({ leases: [] }))).toBeUndefined();
		expect(parseClaim(JSON.stringify({ leases: [{ udid: "x" }] }))).toBeUndefined();
	});
});

describe("heartbeatDevice (19-2)", () => {
	test("refreshes exactly the lease id", async () => {
		const exec = fakeExec([{ cmd: process.execPath, result: {} }]);
		const r = await heartbeatDevice(exec, { cliPath: "/cli.ts", leaseId: "L1", repoRoot: "/repo" });
		expect(r.success).toBe(true);
		expect(exec.calls[0]?.args).toEqual(["/cli.ts", "heartbeat", "L1"]);
		expect(exec.calls[0]?.options?.cwd).toBe("/repo");
	});
	test("failure surfaces", async () => {
		const r = await heartbeatDevice(fakeExec([{ cmd: process.execPath, result: { code: 1, stderr: "x" } }]), {
			cliPath: "/c",
			leaseId: "L",
		});
		expect(r.success).toBe(false);
	});
});

describe("releaseDevice", () => {
	test("releases exactly the lease id, never --mine", async () => {
		const exec = fakeExec([{ cmd: process.execPath, result: {} }]);
		const r = await releaseDevice(exec, { cliPath: "/cli.ts", leaseId: "L1" });
		expect(r.success).toBe(true);
		expect(exec.calls[0]?.args).toEqual(["/cli.ts", "release", "L1"]);
	});
	test("failure surfaces", async () => {
		const r = await releaseDevice(fakeExec([{ cmd: process.execPath, result: { code: 2 } }]), {
			cliPath: "/c",
			leaseId: "L",
		});
		expect(r.success).toBe(false);
	});
});

describe("deviceInfo", () => {
	test("ios: name and runtime from simctl", async () => {
		const exec = fakeExec([{ cmd: "xcrun", result: { stdout: SIMCTL } }]);
		expect(await deviceInfo(exec, "ios", "U1")).toEqual({
			success: true,
			data: { name: "iPhone 16", runtime: "iOS 18.2" },
		});
	});
	test("ios: unknown udid is empty", async () => {
		const exec = fakeExec([{ cmd: "xcrun", result: { stdout: SIMCTL } }]);
		expect(await deviceInfo(exec, "ios", "ZZ")).toEqual({ success: true, data: {} });
	});
	test("android: getprop", async () => {
		const exec = fakeExec([
			{ cmd: "adb", match: (a) => a.includes("ro.product.model"), result: { stdout: "sdk_gphone64_arm64\n" } },
			{ cmd: "adb", match: (a) => a.includes("ro.build.version.release"), result: { stdout: "15\n" } },
		]);
		expect(await deviceInfo(exec, "android", "emulator-5554")).toEqual({
			success: true,
			data: { name: "sdk_gphone64_arm64", runtime: "Android 15" },
		});
	});
});
