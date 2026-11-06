import { describe, expect, test } from "bun:test";
import { axVerdict } from "./ax-quarantine";

describe("axVerdict", () => {
	test("a warm device is kept, whatever its recovery record", () => {
		expect(axVerdict({ socketPath: "/s", axRecovery: { outcome: "recovered" } })).toEqual({ kind: "keep" });
	});

	test("cold without a wedge found runs cold, as before", () => {
		expect(axVerdict({ error: "snapshot failed: AX denied" })).toEqual({ kind: "keep" });
		expect(axVerdict({})).toEqual({ kind: "keep" });
	});

	test("cold after a failed recovery is quarantined", () => {
		expect(
			axVerdict({ error: "snapshot failed: E_TIMEOUT", axRecovery: { outcome: "failed", error: "kickstart: 1" } })
		).toEqual({
			kind: "quarantine",
			reason: "accessibility service wedged, recovery failed: kickstart: 1",
		});
	});

	test("cold although the recovery said recovered is quarantined", () => {
		expect(axVerdict({ error: "snapshot failed: E_TIMEOUT", axRecovery: { outcome: "recovered" } })).toEqual({
			kind: "quarantine",
			reason: "accessibility service wedged, still not answering after recovery: snapshot failed: E_TIMEOUT",
		});
	});

	test("an outcome this build does not know only drops the device from the run", () => {
		const record = JSON.parse('{"outcome":"rebooted"}');
		expect(axVerdict({ error: "snapshot failed: E_TIMEOUT", axRecovery: record })).toEqual({
			kind: "drop",
			reason: "accessibility service wedged (recovery: rebooted), still not answering: snapshot failed: E_TIMEOUT",
		});
	});

	test("a wedge marker with a last read that failed fast is no verdict: the sim still answers", () => {
		expect(
			axVerdict({
				error: "snapshot failed: named no frontmost application",
				axRecovery: { outcome: "failed", error: "x" },
			})
		).toEqual({ kind: "keep" });
	});

	test("an interrupted warm-up is never a verdict", () => {
		expect(axVerdict({ error: "interrupted", axRecovery: { outcome: "failed", error: "x" } })).toEqual({
			kind: "keep",
		});
	});
});
