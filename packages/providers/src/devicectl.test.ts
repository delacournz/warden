import { describe, expect, test } from "bun:test";
import type { Exec, ExecResult } from "@delacour/warden-runtime/exec";
import {
	DEVICECTL_TIMEOUTS,
	Devicectl,
	devicectlArgv,
	devicectlParser,
	NAMED_PROBE_MS,
	REACHABLE_PROBE_MS,
} from "./devicectl";
import {
	DEVICECTL_LIST_EMPTY,
	DEVICECTL_LIST_MIXED,
	DEVICECTL_LOCKSTATE_LOCKED,
	DEVICECTL_LOCKSTATE_UNLOCKED,
	devicectlFixtures,
	FAKE_IPAD_UDID,
	FAKE_IPHONE_UDID,
	FAKE_UNPAIRED_UDID,
} from "./devicectl.fixtures";
import { type TimedExec, timers } from "./health";

function runner(result: Partial<ExecResult> | (() => Promise<ExecResult>), calls: string[][] = []): TimedExec {
	const exec: Exec = async (cmd) => {
		calls.push([...cmd]);
		if (typeof result === "function") return result();
		return { exitCode: 0, stdout: "", stderr: "", ...result };
	};
	return { exec, timer: timers.real };
}

describe("parseDevicectlDevices", () => {
	const parsed = devicectlParser.parseDevices(DEVICECTL_LIST_MIXED);
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
		const out = devicectlParser.parseDevices(
			devicectlFixtures.json([
				devicectlFixtures.entry({
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
		const out = devicectlParser.parseDevices(DEVICECTL_LIST_EMPTY);
		expect(out).toEqual({ success: true, data: [] });
	});

	test("falls back to the `properties` block when the deprecated keys are gone", () => {
		const entry = devicectlFixtures.entry({
			udid: FAKE_IPHONE_UDID,
			name: "Test iPhone",
			deviceType: "iPhone",
			osVersion: "27.2",
		});
		const { hardwareProperties: _h, deviceProperties: _d, connectionProperties: _c, ...rest } = entry;
		const out = devicectlParser.parseDevices(
			devicectlFixtures.json([
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
		expect(devicectlParser.parseDevices("nope").success).toBe(false);
		expect(devicectlParser.parseDevices("{}").success).toBe(false);
	});

	test("skips an entry with no udid instead of failing the list", () => {
		const out = devicectlParser.parseDevices(
			devicectlFixtures.json([{ hardwareProperties: { reality: "physical", platform: "iOS" } }])
		);
		expect(out).toEqual({ success: true, data: [] });
	});
});

describe("listPhysicalIos", () => {
	test("asks devicectl for JSON on stdout, bounded", async () => {
		const calls: string[][] = [];
		const out = await new Devicectl(runner({ stdout: DEVICECTL_LIST_MIXED }, calls)).listPhysical();
		expect(calls[0]).toEqual(devicectlArgv.listDevices());
		expect(devicectlArgv.listDevices()).toContain("--json-output");
		expect(out.success && out.data).toHaveLength(3);
	});

	test("a failing devicectl is an error, never a throw", async () => {
		const out = await new Devicectl(runner({ exitCode: 1, stderr: "boom" })).listPhysical();
		expect(out.success).toBe(false);
	});

	test("a missing binary is an error", async () => {
		const out = await new Devicectl(
			runner({ exitCode: 127, stderr: "xcrun: error: unable to find utility" })
		).listPhysical();
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
		const out = await new Devicectl(timed).listPhysical();
		expect(out.success).toBe(false);
		expect(!out.success && out.error).toContain("did not finish");
	});
});

describe("lock state", () => {
	test("lockStateArgv targets the device", () => {
		expect(devicectlArgv.lockState(FAKE_IPHONE_UDID)).toEqual(
			expect.arrayContaining(["xcrun", "devicectl", "device", "info", "lockState", "--device", FAKE_IPHONE_UDID])
		);
	});

	test("readLockState tells locked from unlocked", async () => {
		const unlocked = await new Devicectl(runner({ stdout: DEVICECTL_LOCKSTATE_UNLOCKED })).readLockState(
			FAKE_IPHONE_UDID
		);
		expect(unlocked).toEqual({ success: true, data: { locked: false } });
		const locked = await new Devicectl(runner({ stdout: DEVICECTL_LOCKSTATE_LOCKED })).readLockState(FAKE_IPHONE_UDID);
		expect(locked).toEqual({ success: true, data: { locked: true } });
	});

	test("probe passes when devicectl answers, locked or not", async () => {
		const calls: string[][] = [];
		expect(
			(await new Devicectl(runner({ stdout: DEVICECTL_LOCKSTATE_UNLOCKED }, calls)).probe(FAKE_IPHONE_UDID)).success
		).toBe(true);
		expect((await new Devicectl(runner({ stdout: DEVICECTL_LOCKSTATE_LOCKED })).probe(FAKE_IPHONE_UDID)).success).toBe(
			true
		);
	});

	test("probe fails when devicectl cannot reach the phone", async () => {
		const out = await new Devicectl(runner({ exitCode: 1, stderr: "The device is not connected" })).probe(
			FAKE_IPHONE_UDID
		);
		expect(out.success).toBe(false);
		expect(!out.success && out.error).toContain("not connected");
	});

	test("probe fails on unreadable output", async () => {
		expect((await new Devicectl(runner({ stdout: "garbage" })).probe(FAKE_IPHONE_UDID)).success).toBe(false);
	});
});

describe("reachability of listed phones", () => {
	const phone = (over: { transportType?: string; tunnelState?: string; udid?: string }) =>
		devicectlFixtures.json([
			devicectlFixtures.entry({
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
		return { exec, timer: timers.real };
	}

	test("a connected tunnel is reachable without a probe", async () => {
		const calls: string[][] = [];
		const out = await new Devicectl(both(phone({ tunnelState: "connected" }), { exitCode: 1 }, calls)).listPhysical();
		expect(out.success && out.data[0]?.state).toBe("booted");
		expect(calls.some((c) => c.includes("lockState"))).toBe(false);
	});

	test("a wired phone is reachable without a probe", async () => {
		const calls: string[][] = [];
		const out = await new Devicectl(both(phone({ transportType: "wired" }), { exitCode: 1 }, calls)).listPhysical();
		expect(out.success && out.data[0]?.state).toBe("booted");
		expect(calls.some((c) => c.includes("lockState"))).toBe(false);
	});

	test("a disconnected network phone that answers lockState is ready", async () => {
		const out = await new Devicectl(both(phone({}), { stdout: DEVICECTL_LOCKSTATE_LOCKED })).listPhysical();
		expect(out.success && out.data[0]?.state).toBe("booted");
		expect(out.success && out.data[0]?.physical).not.toHaveProperty("unreachable");
	});

	test("a disconnected network phone that does not answer is unreachable and never ready", async () => {
		const calls: string[][] = [];
		const out = await new Devicectl(
			both(phone({}), { exitCode: 1, stderr: "The device is not connected" }, calls)
		).listPhysical();
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
			ms === REACHABLE_PROBE_MS ? { promise: Promise.resolve(), cancel: () => {} } : timers.real(ms);
		const out = await new Devicectl({ exec, timer }).listPhysical();
		expect(out.success && out.data[0]?.state).toBe("shutdown");
	});

	test("a phone that is not ready for another reason is not probed", async () => {
		const calls: string[][] = [];
		await new Devicectl(both(DEVICECTL_LIST_MIXED, { stdout: DEVICECTL_LOCKSTATE_LOCKED }, calls)).listPhysical();
		expect(calls.filter((c) => c.includes("lockState"))).toHaveLength(0);
	});
	const probeTimeout = (calls: string[][]) => {
		const probe = calls.find((c) => c.includes("lockState")) ?? [];
		return probe[probe.indexOf("--timeout") + 1];
	};

	test("a phone named by the caller gets the longer bounded wait; an auto-picked one the short probe", async () => {
		const named: string[][] = [];
		await new Devicectl(both(phone({}), { stdout: DEVICECTL_LOCKSTATE_UNLOCKED }, named)).listPhysical({
			named: [FAKE_IPAD_UDID],
		});
		expect(probeTimeout(named)).toBe(String(NAMED_PROBE_MS / 1000));
		const auto: string[][] = [];
		await new Devicectl(both(phone({}), { stdout: DEVICECTL_LOCKSTATE_UNLOCKED }, auto)).listPhysical({
			named: ["someone-else"],
		});
		expect(probeTimeout(auto)).toBe(String(REACHABLE_PROBE_MS / 1000));
		expect(NAMED_PROBE_MS).toBeGreaterThan(REACHABLE_PROBE_MS);
	});

	test("a named phone that hangs is cut off at the named bound", async () => {
		const exec: Exec = async (cmd) =>
			cmd.includes("lockState") ? new Promise<ExecResult>(() => {}) : { exitCode: 0, stdout: phone({}), stderr: "" };
		const timer = (ms: number) =>
			ms === NAMED_PROBE_MS ? { promise: Promise.resolve(), cancel: () => {} } : timers.real(ms);
		const out = await new Devicectl({ exec, timer }).listPhysical({ named: [FAKE_IPAD_UDID] });
		expect(out.success && out.data[0]?.state).toBe("shutdown");
		const why = out.success && out.data[0]?.physical?.platform === "ios" && out.data[0].physical.unreachable;
		expect(why).toContain(`${NAMED_PROBE_MS / 1000}s`);
	});

	test("several unreachable-looking phones are probed in parallel, not one after another", async () => {
		const two = devicectlFixtures.json([
			devicectlFixtures.entry({
				udid: FAKE_IPAD_UDID,
				name: "A",
				deviceType: "iPad",
				osVersion: "18.7.8",
				transportType: "localNetwork",
				tunnelState: "disconnected",
			}),
			devicectlFixtures.entry({
				udid: FAKE_IPHONE_UDID,
				name: "B",
				deviceType: "iPhone",
				osVersion: "27.2",
				transportType: "localNetwork",
				tunnelState: "disconnected",
			}),
		]);
		let inFlight = 0;
		let peak = 0;
		const exec: Exec = async (cmd) => {
			if (!cmd.includes("lockState")) return { exitCode: 0, stdout: two, stderr: "" };
			inFlight++;
			peak = Math.max(peak, inFlight);
			await Bun.sleep(5);
			inFlight--;
			return { exitCode: 0, stdout: DEVICECTL_LOCKSTATE_UNLOCKED, stderr: "" };
		};
		await new Devicectl({ exec, timer: timers.real }).listPhysical();
		expect(peak).toBe(2);
	});

	test("a probe that answers records whether the phone is locked (reachable either way)", async () => {
		const locked = await new Devicectl(both(phone({}), { stdout: DEVICECTL_LOCKSTATE_LOCKED })).listPhysical();
		const unlocked = await new Devicectl(both(phone({}), { stdout: DEVICECTL_LOCKSTATE_UNLOCKED })).listPhysical();
		const lockedOf = (o: typeof locked) =>
			o.success && o.data[0]?.physical?.platform === "ios" ? o.data[0].physical.locked : "?";
		expect(lockedOf(locked)).toBe(true);
		expect(lockedOf(unlocked)).toBe(false);
		expect(locked.success && locked.data[0]?.state).toBe("booted");
	});
});
