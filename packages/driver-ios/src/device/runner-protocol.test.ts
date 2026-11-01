import { describe, expect, test } from "bun:test";
import { runnerProtocol } from "./runner-protocol";

describe("runner protocol", () => {
	test("appState replies parse; anything else is undefined", () => {
		expect(runnerProtocol.parseAppState({ state: "runningForeground" })).toBe("runningForeground");
		expect(runnerProtocol.parseAppState({ state: "somethingNew" })).toBe("unknown");
		expect(runnerProtocol.parseAppState(null)).toBeUndefined();
		expect(runnerProtocol.parseAppState({})).toBeUndefined();
	});

	test("a suspended background app still counts as running, a stopped one does not", () => {
		expect(runnerProtocol.isRunning("runningBackgroundSuspended")).toBe(true);
		expect(runnerProtocol.isRunning("notRunning")).toBe(false);
		expect(runnerProtocol.isRunning("unknown")).toBe(false);
	});
});
