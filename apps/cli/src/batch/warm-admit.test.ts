import { describe, expect, test } from "bun:test";
import type { DeviceWarm } from "./early-warm";
import { type DroppedDevice, warmAdmit } from "./warm-admit";

const FAILED: DeviceWarm = { error: "snapshot failed: E_TIMEOUT", axRecovery: { outcome: "failed", error: "kick" } };

function admitWith(done: DeviceWarm, quarantine: (udid: string) => boolean = () => true) {
	const lines: string[] = [];
	const asked: string[] = [];
	const dropped = new Map<string, DroppedDevice>();
	const admit = warmAdmit({
		warm: { device: async () => done },
		quarantine: (udid) => {
			asked.push(udid);
			return quarantine(udid);
		},
		report: (line) => lines.push(line),
		dropped,
	});
	return { admit, lines, asked, dropped };
}

describe("warmAdmit", () => {
	test("a warm device is admitted, nothing quarantined", async () => {
		const a = admitWith({ socketPath: "/s" });
		expect(await a.admit({ worker: 0, udid: "U1" })).toBe(true);
		expect(a.asked).toEqual([]);
		expect(a.dropped.size).toBe(0);
	});

	test("an unrecovered wedge is refused, quarantined and reported", async () => {
		const a = admitWith(FAILED);
		expect(await a.admit({ worker: 0, udid: "U1" })).toBe(false);
		expect(a.asked).toEqual(["U1"]);
		expect(a.dropped.get("U1")).toEqual({
			reason: "accessibility service wedged, recovery failed: kick",
			quarantined: true,
		});
		expect(a.lines).toEqual([
			"U1: accessibility service wedged, recovery failed: kick; dropped and quarantined (clear with: warden sim unquarantine U1)",
		]);
	});

	test("a device that is not warden's (or a quarantine that throws) is only dropped", async () => {
		const foreign = admitWith(FAILED, () => false);
		expect(await foreign.admit({ worker: 0, udid: "U1" })).toBe(false);
		expect(foreign.lines[0]).toEndWith("; dropped");
		const broken = admitWith(FAILED, () => {
			throw new Error("db locked");
		});
		expect(await broken.admit({ worker: 0, udid: "U1" })).toBe(false);
		expect(broken.dropped.get("U1")?.quarantined).toBe(false);
	});

	test("an unknown recovery outcome drops without quarantining", async () => {
		const a = admitWith({ error: "snapshot failed: E_TIMEOUT", axRecovery: JSON.parse('{"outcome":"rebooted"}') });
		expect(await a.admit({ worker: 0, udid: "U1" })).toBe(false);
		expect(a.asked).toEqual([]);
	});
});
