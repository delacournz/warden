import { describe, expect, test } from "bun:test";
import { type SetupRun, setupDevices } from "./setup";

function run(command: string, udids: string[]): { run: SetupRun; spawned: string[][] } {
	const spawned: string[][] = [];
	return {
		spawned,
		run: {
			devices: udids.map((udid, worker) => ({ worker, udid })),
			spec: { command },
			env: {},
			cwd: "/repo",
			logDir: "/logs",
			spawn: (cmd) => {
				spawned.push(cmd);
				return { exited: Promise.resolve(0) };
			},
		},
	};
}

describe("setupDevices", () => {
	test("{udid} is substituted with the device id, once per device", async () => {
		const { run: r, spawned } = run("xcrun simctl spawn {udid} true # {udid}", ["A-1", "emulator-5554"]);
		const done = await setupDevices(r);
		expect(done.map((d) => d.ok)).toEqual([true, true]);
		expect(spawned).toEqual([
			["sh", "-c", "xcrun simctl spawn A-1 true # A-1"],
			["sh", "-c", "xcrun simctl spawn emulator-5554 true # emulator-5554"],
		]);
	});

	test("a device id that is not a plain word is substituted as one quoted shell word, as written", async () => {
		const { run: r, spawned } = run("echo {udid}", ["a b $& c"]);
		await setupDevices(r);
		expect(spawned).toEqual([["sh", "-c", "echo 'a b $& c'"]]);
	});
});
