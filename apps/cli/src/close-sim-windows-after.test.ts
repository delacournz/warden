import { describe, expect, test } from "bun:test";
import { closeSimWindowsAfter, type SimWindowsLoader } from "./close-sim-windows-after";
import { fakeExec } from "./testing";

function counting(): { load: SimWindowsLoader; loads: () => number } {
	let n = 0;
	return {
		load: async () => {
			n++;
			return import("./sim-windows");
		},
		loads: () => n,
	};
}

const SIM = { udid: "U1", name: "warden-iphone-17-1" };

describe("closeSimWindowsAfter", () => {
	test("closes the shut-down sims' Device Hub windows in one osascript call, by name", async () => {
		const calls: string[][] = [];
		const exec = fakeExec(
			[
				["pgrep -xq Simulator", { exitCode: 1 }],
				["pgrep -xq DeviceHub", { exitCode: 0 }],
				["osascript", {}],
			],
			calls
		);
		const error = await closeSimWindowsAfter({ exec, os: "darwin" }, [SIM, { udid: "U2", name: "warden-iphone-17-2" }]);
		expect(error).toBeUndefined();
		const closes = calls.filter((c) => c[0] === "osascript");
		expect(closes).toHaveLength(1);
		expect(JSON.parse(closes[0]?.[5] ?? "")).toEqual(["warden-iphone-17-1", "warden-iphone-17-2"]);
	});

	test("a failed close comes back as the error, never a throw", async () => {
		const exec = fakeExec([
			["pgrep -xq Simulator", { exitCode: 1 }],
			["pgrep -xq DeviceHub", { exitCode: 0 }],
			["osascript", { exitCode: 1, stderr: "not allowed assistive access" }],
		]);
		expect(await closeSimWindowsAfter({ exec, os: "darwin" }, [SIM])).toContain("Accessibility");
	});

	test("nothing shut down, or not macOS → the window module is never loaded", async () => {
		const calls: string[][] = [];
		const exec = fakeExec([], calls);
		const { load, loads } = counting();
		expect(await closeSimWindowsAfter({ exec, os: "darwin" }, [], load)).toBeUndefined();
		expect(await closeSimWindowsAfter({ exec, os: "linux" }, [SIM], load)).toBeUndefined();
		expect(loads()).toBe(0);
		expect(calls).toEqual([]);
	});
});
