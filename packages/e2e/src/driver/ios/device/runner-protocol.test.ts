import { describe, expect, test } from "bun:test";
import { isRunning, parseAppState } from "./runner-protocol";

describe("runner protocol", () => {
	test("appState replies parse; anything else is undefined", () => {
		expect(parseAppState({ state: "runningForeground" })).toBe("runningForeground");
		expect(parseAppState({ state: "somethingNew" })).toBe("unknown");
		expect(parseAppState(null)).toBeUndefined();
		expect(parseAppState({})).toBeUndefined();
	});

	test("a suspended background app still counts as running, a stopped one does not", () => {
		expect(isRunning("runningBackgroundSuspended")).toBe(true);
		expect(isRunning("notRunning")).toBe(false);
		expect(isRunning("unknown")).toBe(false);
	});
});
