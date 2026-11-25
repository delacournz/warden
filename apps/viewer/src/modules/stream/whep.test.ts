import { describe, expect, test } from "bun:test";
import { backoffDelay, iceGatheringComplete } from "./whep.ts";

describe("backoffDelay", () => {
	test("doubles from one second and caps at fifteen", () => {
		expect([0, 1, 2, 3, 4, 5, 9].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
	});
});

class FakeGatherer extends EventTarget {
	iceGatheringState: RTCIceGatheringState = "gathering";
	finish() {
		this.iceGatheringState = "complete";
		this.dispatchEvent(new Event("icegatheringstatechange"));
	}
}

describe("iceGatheringComplete", () => {
	test("resolves at once when gathering is already complete", async () => {
		const pc = new FakeGatherer();
		pc.iceGatheringState = "complete";
		expect(await iceGatheringComplete(pc, 10_000)).toBe("complete");
	});

	test("resolves when gathering completes", async () => {
		const pc = new FakeGatherer();
		const done = iceGatheringComplete(pc, 10_000);
		pc.finish();
		expect(await done).toBe("complete");
	});

	test("gives up after the timeout so a slow candidate never stalls the offer", async () => {
		expect(await iceGatheringComplete(new FakeGatherer(), 5)).toBe("timeout");
	});
});
