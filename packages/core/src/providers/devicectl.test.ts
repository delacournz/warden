import { describe, expect, test } from "bun:test";
import type { Exec, ExecResult } from "../exec";
import {
	DEVICECTL_TIMEOUTS,
	listDevicesArgv,
	listPhysicalIos,
	lockStateArgv,
	parseDevicectlDevices,
	probePhysicalIos,
	REACHABLE_PROBE_MS,
	readLockState,
} from "./devicectl";
import {
	DEVICECTL_LIST_EMPTY,
	DEVICECTL_LIST_MIXED,
	DEVICECTL_LOCKSTATE_LOCKED,
	DEVICECTL_LOCKSTATE_UNLOCKED,
	devicectlEntry,
	devicectlJson,
	FAKE_IPAD_UDID,
	FAKE_IPHONE_UDID,
	FAKE_UNPAIRED_UDID,
} from "./devicectl.fixtures";
import { realTimer, type TimedExec } from "./health";

function runner(result: Partial<ExecResult> | (() => Promise<ExecResult>), calls: string[][] = []): TimedExec {
	const exec: Exec = async (cmd) => {
		calls.push([...cmd]);
		if (typeof result === "function") return result();
		return { exitCode: 0, stdout: "", stderr: "", ...result };
	};
	return { exec, timer: realTimer };
}

describe("parseDevicectlDevices", () => {
	const parsed = parseDevicectlDevices(DEVICECTL_LIST_MIXED);
	const devices = parsed.success ? parsed.data : [];

	test("keeps only physical iOS / iPadOS devices", () => {
		expect(parsed.success).toBe(true);
		expect(devices.map((d) => d.id)).toEqual([FAKE_IPHONE_UDID, FAKE_IPAD_UDID, FAKE_UNPAIRED_UDID]);
	});

	test("a paired phone with Developer Mode on is booted and carries its facts", () => {
		expect(devices[0]).toEqual({
			platform: "ios",
			id: FAKE_IPHONE_UDID,
			name: "Test iPhone",
			state: "booted",
			wardenCreated: false,
			physical: {
				platform: "ios",
				transport: "localNetwork",
				deviceType: "iPhone",
				osVersion: "27.2",
				developerMode: true,
				ddi: true,
				tunnelIp: "fd00:1234:5678::1",
				tunnelState: "connected",
			},
		});
	});

	test("Developer Mode off is not ready, with the reason in PhysicalInfo", () => {
		const ipad = devices[1];
		expect(ipad?.state).toBe("shutdown");
		expect(ipad?.physical).toMatchObject({ transport: "wired", developerMode: false, ddi: false });
		expect(ipad?.physical?.platform === "ios" && ipad.physical.tunnelIp).toBeFalsy();
	});

	test("an unpaired device is not ready", () => {
		expect(devices[2]?.state).toBe("shutdown");
		expect(devices[2]?.physical).toMatchObject({ pairingState: "unpaired" });
	});

	test("an iPadOS platform string counts", () => {
		const out = parseDevicectlDevices(
			devicectlJson([
				devicectlEntry({
					udid: FAKE_IPAD_UDID,
					name: "Test iPad",
					deviceType: "iPad",
					platform: "iPadOS",
					osVersion: "26.0",
				}),
			])
		);
		expect(out.success && out.data.map((d) => d.id)).toEqual([FAKE_IPAD_UDID]);
	});

	test("an empty list parses to nothing", () => {
		const out = parseDevicectlDevices(DEVICECTL_LIST_EMPTY);
		expect(out).toEqual({ success: true, data: [] });
	});

	test("falls back to the `properties` block when the deprecated keys are gone", () => {
		const entry = devicectlEntry({
			udid: FAKE_IPHONE_UDID,
			name: "Test iPhone",
			deviceType: "iPhone",
			osVersion: "27.2",
		});
		const { hardwareProperties: _h, deviceProperties: _d, connectionProperties: _c, ...rest } = entry;
		const out = parseDevicectlDevices(
			devicectlJson([
				{
					...rest,
					properties: {
						hardware: { udid: FAKE_IPHONE_UDID, reality: "physical", platform: "iOS", deviceType: "iPhone" },
						connection: { pairingState: "paired", transportType: "wired" },
						software: { osVersionNumber: { stringValue: "27.2" } },
						state: { name: "Test iPhone", developerModeStatus: { enabled: { mode: 1 } } },
					},
				},
			])
		);
		expect(out.success && out.data[0]).toMatchObject({ id: FAKE_IPHONE_UDID, name: "Test iPhone", state: "booted" });
	});

	test("rejects malformed json and a missing result", () => {
		expect(parseDevicectlDevices("nope").success).toBe(false);
		expect(parseDevicectlDevices("{}").success).toBe(false);
	});

	test("skips an entry with no udid instead of failing the list", () => {
		const out = parseDevicectlDevices(
			devicectlJson([{ hardwareProperties: { reality: "physical", platform: "iOS" } }])
		);
		expect(out).toEqual({ success: true, data: [] });
	});
});

describe("listPhysicalIos", () => {
	test("asks devicectl for JSON on stdout, bounded", async () => {
		const calls: string[][] = [];
		const out = await listPhysicalIos(runner({ stdout: DEVICECTL_LIST_MIXED }, calls));
		expect(calls[0]).toEqual(listDevicesArgv());
		expect(listDevicesArgv()).toContain("--json-output");
		expect(out.success && out.data).toHaveLength(3);
	});

	test("a failing devicectl is an error, never a throw", async () => {
		const out = await listPhysicalIos(runner({ exitCode: 1, stderr: "boom" }));
		expect(out.success).toBe(false);
	});

	test("a missing binary is an error", async () => {
		const out = await listPhysicalIos(runner({ exitCode: 127, stderr: "xcrun: error: unable to find utility" }));
		expect(out.success).toBe(false);
	});

	test("a hung devicectl is cut off at the list timeout", async () => {
		const never = (): Promise<ExecResult> => new Promise(() => {});
		const timed: TimedExec = {
			exec: async () => never(),
			timer: (ms) => {
				expect(ms).toBe(DEVICECTL_TIMEOUTS.listMs);
				return { promise: Promise.resolve(), cancel: () => {} };
			},
		};
		const out = await listPhysicalIos(timed);
		expect(out.success).toBe(false);
		expect(!out.success && out.error).toContain("did not finish");
	});
});

describe("lock state", () => {
	test("lockStateArgv targets the device", () => {
		expect(lockStateArgv(FAKE_IPHONE_UDID)).toEqual(
			expect.arrayContaining(["xcrun", "devicectl", "device", "info", "lockState", "--device", FAKE_IPHONE_UDID])
		);
	});

	test("readLockState tells locked from unlocked", async () => {
		const unlocked = await readLockState(runner({ stdout: DEVICECTL_LOCKSTATE_UNLOCKED }), FAKE_IPHONE_UDID);
		expect(unlocked).toEqual({ success: true, data: { locked: false } });
		const locked = await readLockState(runner({ stdout: DEVICECTL_LOCKSTATE_LOCKED }), FAKE_IPHONE_UDID);
		expect(locked).toEqual({ success: true, data: { locked: true } });
	});

	test("probe passes when devicectl answers, locked or not", async () => {
		const calls: string[][] = [];
		expect(
			(await probePhysicalIos(runner({ stdout: DEVICECTL_LOCKSTATE_UNLOCKED }, calls), FAKE_IPHONE_UDID)).success
		).toBe(true);
		expect((await probePhysicalIos(runner({ stdout: DEVICECTL_LOCKSTATE_LOCKED }), FAKE_IPHONE_UDID)).success).toBe(
			true
		);
	});

	test("probe fails when devicectl cannot reach the phone", async () => {
		const out = await probePhysicalIos(
			runner({ exitCode: 1, stderr: "The device is not connected" }),
			FAKE_IPHONE_UDID
		);
		expect(out.success).toBe(false);
		expect(!out.success && out.error).toContain("not connected");
	});

	test("probe fails on unreadable output", async () => {
		expect((await probePhysicalIos(runner({ stdout: "garbage" }), FAKE_IPHONE_UDID)).success).toBe(false);
	});
});

describe("reachability of listed phones", () => {
	const phone = (over: { transportType?: string; tunnelState?: string; udid?: string }) =>
		devicectlJson([
			devicectlEntry({
				udid: over.udid ?? FAKE_IPAD_UDID,
				name: "Test iPad",
				deviceType: "iPad",
				osVersion: "18.7.8",
				transportType: over.transportType ?? "localNetwork",
				tunnelState: over.tunnelState ?? "disconnected",
			}),
		]);

	/** answers `list` with `listJson` and `lockState` with `lock` */
	function both(listJson: string, lock: Partial<ExecResult>, calls: string[][] = []): TimedExec {
		const exec: Exec = async (cmd) => {
			calls.push([...cmd]);
			const body = cmd.includes("lockState") ? lock : { stdout: listJson };
			return { exitCode: 0, stdout: "", stderr: "", ...body };
		};
		return { exec, timer: realTimer };
	}

	test("a connected tunnel is reachable without a probe", async () => {
		const calls: string[][] = [];
		const out = await listPhysicalIos(both(phone({ tunnelState: "connected" }), { exitCode: 1 }, calls));
		expect(out.success && out.data[0]?.state).toBe("booted");
		expect(calls.some((c) => c.includes("lockState"))).toBe(false);
	});

	test("a wired phone is reachable without a probe", async () => {
		const calls: string[][] = [];
		const out = await listPhysicalIos(both(phone({ transportType: "wired" }), { exitCode: 1 }, calls));
		expect(out.success && out.data[0]?.state).toBe("booted");
		expect(calls.some((c) => c.includes("lockState"))).toBe(false);
	});

	test("a disconnected network phone that answers lockState is ready", async () => {
		const out = await listPhysicalIos(both(phone({}), { stdout: DEVICECTL_LOCKSTATE_LOCKED }));
		expect(out.success && out.data[0]?.state).toBe("booted");
		expect(out.success && out.data[0]?.physical).not.toHaveProperty("unreachable");
	});

	test("a disconnected network phone that does not answer is unreachable and never ready", async () => {
		const calls: string[][] = [];
		const out = await listPhysicalIos(both(phone({}), { exitCode: 1, stderr: "The device is not connected" }, calls));
		const device = out.success ? out.data[0] : undefined;
		expect(device?.state).toBe("shutdown");
		expect(device?.physical?.platform === "ios" && device.physical.unreachable).toContain("not connected");
		const probe = calls.find((c) => c.includes("lockState")) ?? [];
		expect(probe[probe.indexOf("--timeout") + 1]).toBe(String(REACHABLE_PROBE_MS / 1000));
	});

	test("a phone that hangs is cut off at the probe bound", async () => {
		const exec: Exec = async (cmd) =>
			cmd.includes("lockState") ? new Promise<ExecResult>(() => {}) : { exitCode: 0, stdout: phone({}), stderr: "" };
		const timer = (ms: number) =>
			ms === REACHABLE_PROBE_MS ? { promise: Promise.resolve(), cancel: () => {} } : realTimer(ms);
		const out = await listPhysicalIos({ exec, timer });
		expect(out.success && out.data[0]?.state).toBe("shutdown");
	});

	test("a phone that is not ready for another reason is not probed", async () => {
		const calls: string[][] = [];
		await listPhysicalIos(both(DEVICECTL_LIST_MIXED, { stdout: DEVICECTL_LOCKSTATE_LOCKED }, calls));
		expect(calls.filter((c) => c.includes("lockState"))).toHaveLength(0);
	});
});
