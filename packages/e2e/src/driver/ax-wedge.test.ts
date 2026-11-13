import { describe, expect, test } from "bun:test";
import { type AxWedgeState, restartedWithin } from "./ax-wedge";

const state = (last?: AxWedgeState["last"], recovering = false): AxWedgeState => ({
	restarts: last?.outcome === "restarted" ? 1 : 0,
	maxRestarts: 1,
	recovering,
	...(last ? { last } : {}),
});

describe("ax wedge state", () => {
	test("a restart inside the window counts, one before it does not", () => {
		expect(restartedWithin(state({ outcome: "restarted", agoMs: 3_000, ms: 2_100 }), 10_000)).toBe(true);
		expect(restartedWithin(state({ outcome: "restarted", agoMs: 12_000 }), 10_000)).toBe(false);
	});

	test("a check that found no wedge, or failed, is no restart", () => {
		expect(restartedWithin(state({ outcome: "not-wedged", agoMs: 100 }), 10_000)).toBe(false);
		expect(restartedWithin(state({ outcome: "failed", agoMs: 100, error: "log show: exit 1" }), 10_000)).toBe(false);
		expect(restartedWithin(state(), 10_000)).toBe(false);
	});
});
