import { describe, expect, test } from "bun:test";
import { isRunning, newRunnerToken, parseAppState, RUNNER_TOKEN_ENV, runnerAuthLine } from "./runner-protocol";

describe("runner protocol", () => {
	test("appState replies parse; anything else is undefined", () => {
		expect(parseAppState({ state: "runningForeground" })).toBe("runningForeground");
		expect(parseAppState({ state: "somethingNew" })).toBe("unknown");
		expect(parseAppState(null)).toBeUndefined();
		expect(parseAppState({})).toBeUndefined();
	});

	test("a session token is 32 random bytes as hex, new every time", () => {
		const token = newRunnerToken();
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		expect(newRunnerToken()).not.toBe(token);
	});

	test("the auth line is the first line a connection sends; xcodebuild forwards the token variable", () => {
		expect(runnerAuthLine("ab12")).toBe('{"op":"auth","token":"ab12"}\n');
		expect(RUNNER_TOKEN_ENV).toBe("TEST_RUNNER_WARDEN_RUNNER_TOKEN");
	});

	test("a suspended background app still counts as running, a stopped one does not", () => {
		expect(isRunning("runningBackgroundSuspended")).toBe(true);
		expect(isRunning("notRunning")).toBe(false);
		expect(isRunning("unknown")).toBe(false);
	});
});
