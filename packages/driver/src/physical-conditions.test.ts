import { describe, expect, test } from "bun:test";
import type { Driver } from "./driver.types";
import { PHYSICAL_CONDITION_OPS, physicalConditionOps } from "./physical-conditions";

describe("physicalConditionOps", () => {
	test("every condition and setting op is E_UNSUPPORTED, naming the device and pointing at a simulator", async () => {
		const ops = physicalConditionOps("physical iPhone R1");
		expect(Object.keys(ops).sort()).toEqual([...PHYSICAL_CONDITION_OPS].sort());
		const calls: Array<ReturnType<Driver[(typeof PHYSICAL_CONDITION_OPS)[number]]>> = [
			ops.network({ kind: "offline" }),
			ops.networkFaults([]),
			ops.location({ kind: "clear" }),
			ops.clock({ kind: "real" }),
			ops.permissions({ camera: "granted" }),
			ops.timezone("Pacific/Auckland"),
			ops.locale("fr-FR"),
			ops.a11y(null),
			ops.battery(null),
			ops.memoryWarning(),
			ops.push({ aps: { alert: "hi" } }),
		];
		for (const call of calls) {
			const result = await call;
			expect(result.success).toBe(false);
			if (result.success) continue;
			expect(result.error.code).toBe("E_UNSUPPORTED");
			expect(result.error.retryable).toBe(false);
			expect(result.error.message).toContain("physical iPhone R1");
			expect(result.error.message).toContain("simulator or emulator");
		}
	});
});
