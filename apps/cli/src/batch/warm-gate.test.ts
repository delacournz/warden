import { describe, expect, test } from "bun:test";
import type { DeviceWarm } from "./early-warm";
import { splitWarmError, warmGate } from "./warm-gate";

const PHONE = "00008140-000A0B0C0D0E0F10";

const warmOf = (outcomes: Record<string, DeviceWarm>) => ({
	device: async (udid: string): Promise<DeviceWarm> => outcomes[udid] ?? {},
});

describe("splitWarmError", () => {
	test("a coded error: the code and the rest", () => {
		expect(splitWarmError("device_locked: E_DEVICE_LOCKED: Unlock the phone (unlock the phone, then retry)")).toEqual({
			code: "device_locked",
			message: "E_DEVICE_LOCKED: Unlock the phone (unlock the phone, then retry)",
		});
	});

	test("an uncoded error: the generic code and the whole text", () => {
		expect(splitWarmError("timed out after 120s")).toEqual({ code: "failed", message: "timed out after 120s" });
	});
});

describe("warmGate", () => {
	test("every device warm: no failure", async () => {
		const warm = warmOf({ [PHONE]: { socketPath: "/tmp/s.sock" } });
		expect(await warmGate([PHONE], warm)).toBeUndefined();
	});

	test("a device that failed to warm: its udid, code and message", async () => {
		const warm = warmOf({ [PHONE]: { error: "device_locked: E_DEVICE_LOCKED: Unlock to Continue", warning: "w" } });
		expect(await warmGate([PHONE], warm)).toEqual({
			udid: PHONE,
			code: "device_locked",
			message: "E_DEVICE_LOCKED: Unlock to Continue",
		});
	});

	test("a failure with no recorded error (never warmed) is still a failure", async () => {
		const warm = warmOf({ [PHONE]: { warning: "warm: timed out after 120s (continuing cold)" } });
		expect((await warmGate([PHONE], warm))?.code).toBe("failed");
	});

	test("only the listed devices are checked", async () => {
		const warm = warmOf({ OTHER: { error: "failed: x", warning: "w" } });
		expect(await warmGate([PHONE], warm)).toBeUndefined();
	});
});
