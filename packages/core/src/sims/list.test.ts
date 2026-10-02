import { describe, expect, test } from "bun:test";
import type { Exec } from "../exec";
import { listAllSims, parseAllSims } from "./list";

const IOS = "com.apple.CoreSimulator.SimRuntime.iOS-26-5";
const IPHONE = "com.apple.CoreSimulator.SimDeviceType.iPhone-17";
const WATCH = "com.apple.CoreSimulator.SimRuntime.watchOS-11-0";

describe("parseAllSims", () => {
	const json = JSON.stringify({
		devices: {
			[IOS]: [
				{
					udid: "U1",
					name: "a",
					state: "Shutdown",
					isAvailable: false,
					deviceTypeIdentifier: IPHONE,
					lastBootedAt: "2026-09-28T01:57:04Z",
					dataPathSize: 4_000,
				},
			],
			[WATCH]: [{ udid: "W", name: "w", state: "Shutdown" }],
		},
	});

	test("keeps unavailable sims + runtime/device type/last boot/size; iOS only by default", () => {
		expect(parseAllSims(json)).toEqual({
			success: true,
			data: [
				{
					udid: "U1",
					name: "a",
					state: "Shutdown",
					isAvailable: false,
					runtimeId: IOS,
					deviceTypeIdentifier: IPHONE,
					lastBootedAt: Date.parse("2026-09-28T01:57:04Z"),
					dataPathSize: 4_000,
				},
			],
		});
	});

	test("allPlatforms keeps watchOS/tvOS/visionOS sims", () => {
		const sims = parseAllSims(json, { allPlatforms: true });
		expect(sims.success && sims.data.map((s) => s.udid)).toEqual(["U1", "W"]);
	});

	test("bad JSON is an error", () => {
		expect(parseAllSims("nope").success).toBe(false);
		expect(parseAllSims("{}").success).toBe(false);
	});
});

describe("listAllSims", () => {
	test("keeps sizes from simctl; falls back to du -sk for a missing dataPathSize", async () => {
		const json = JSON.stringify({
			devices: { [WATCH]: [{ udid: "W", name: "watch", state: "Shutdown", isAvailable: true, dataPath: "/d/W/data" }] },
		});
		const calls: string[][] = [];
		const exec: Exec = async (cmd) => {
			calls.push([...cmd]);
			if (cmd[0] === "du") return { exitCode: 0, stdout: "2048\t/d/W/data\n", stderr: "" };
			return { exitCode: 0, stdout: json, stderr: "" };
		};
		const sims = await listAllSims(exec);
		expect(sims.success && sims.data.map((s) => [s.udid, s.dataPathSize])).toEqual([["W", 2048 * 1024]]);
		expect(calls).toContainEqual(["du", "-sk", "/d/W/data"]);
	});

	test("a failing simctl is an error", async () => {
		const exec: Exec = async () => ({ exitCode: 1, stdout: "", stderr: "no xcode" });
		expect((await listAllSims(exec)).success).toBe(false);
	});
});
