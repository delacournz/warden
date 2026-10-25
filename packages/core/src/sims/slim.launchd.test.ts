import { describe, expect, test } from "bun:test";
import type { Exec } from "../exec";
import { chunk, launchdJobPlists, parseDeviceRuntime, parseRuntimeRoot, runtimeRootFor } from "./slim.launchd";

const RT = "com.apple.CoreSimulator.SimRuntime.iOS-27-1";

describe("parseRuntimeRoot", () => {
	test("uses runtimeRoot, else derives it from bundlePath, else undefined", () => {
		const json = JSON.stringify({
			runtimes: [
				{ identifier: RT, runtimeRoot: "/x/RuntimeRoot" },
				{ identifier: "other", bundlePath: "/y/iOS.simruntime" },
			],
		});
		expect(parseRuntimeRoot(json, RT)).toBe("/x/RuntimeRoot");
		expect(parseRuntimeRoot(json, "other")).toBe("/y/iOS.simruntime/Contents/Resources/RuntimeRoot");
		expect(parseRuntimeRoot(json, "missing")).toBeUndefined();
		expect(parseRuntimeRoot("not json", RT)).toBeUndefined();
	});
});

describe("parseDeviceRuntime", () => {
	test("finds the runtime key a udid is listed under", () => {
		const json = JSON.stringify({ devices: { a: [{ udid: "1" }], [RT]: [{ udid: "2" }] } });
		expect(parseDeviceRuntime(json, "2")).toBe(RT);
		expect(parseDeviceRuntime(json, "3")).toBeUndefined();
	});
});

describe("runtimeRootFor", () => {
	test("asks simctl list runtimes -j", async () => {
		const calls: string[][] = [];
		const exec: Exec = async (cmd) => {
			calls.push([...cmd]);
			return { exitCode: 0, stdout: JSON.stringify({ runtimes: [{ identifier: RT, runtimeRoot: "/r" }] }), stderr: "" };
		};
		expect(await runtimeRootFor(exec, RT)).toBe("/r");
		expect(calls).toEqual([["xcrun", "simctl", "list", "runtimes", "-j"]]);
	});
});

describe("launchdJobPlists", () => {
	test("looks in LaunchDaemons then LaunchAgents and only accepts a plist whose Label matches", async () => {
		const files = new Map([
			["/r/System/Library/LaunchDaemons/a.plist", "a"],
			["/r/System/Library/LaunchAgents/b.plist", "b"],
			["/r/System/Library/LaunchDaemons/c.plist", "not-c"],
		]);
		const exec: Exec = async (cmd) => ({
			exitCode: 0,
			stdout: files.get(cmd[cmd.length - 1] as string) ?? "",
			stderr: "",
		});
		const found = await launchdJobPlists(exec, "/r", ["a", "b", "c", "d"], (path) => files.has(path));
		expect([...found]).toEqual([
			["a", "/r/System/Library/LaunchDaemons/a.plist"],
			["b", "/r/System/Library/LaunchAgents/b.plist"],
		]);
	});
});

describe("chunk", () => {
	test("slices", () => {
		expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
		expect(chunk([], 2)).toEqual([]);
	});
});
