import { describe, expect, test } from "bun:test";
import { conditionSpawners } from "./conditions-real";

const scheduler = {
	platform: "android",
	id: "emulator-5554",
	adb: "adb",
	mode: "flap",
	flap: { upMs: 1000, downMs: 500 },
} as const;
const ticker = { adb: "adb", serial: "emulator-5554", points: [{ lat: 1, lon: 2 }] };

function spawned(main: string, execPath: string) {
	const argvs: string[][] = [];
	const spawners = conditionSpawners(main, execPath, (argv) => {
		argvs.push([...argv]);
		return { pid: 10 + argvs.length };
	});
	return { argvs, spawners };
}

describe("conditionSpawners", () => {
	test("compiled: the binary runs its hidden subcommands", () => {
		const { argvs, spawners } = spawned("/$bunfs/root/warden", "/usr/bin/warden");
		expect(spawners.spawnScheduler(scheduler)).toEqual({ success: true, data: { kind: "pid", pid: 11 } });
		expect(spawners.spawnTicker(ticker)).toEqual({ success: true, data: { kind: "pid", pid: 12 } });
		expect(argvs[0]?.slice(0, 2)).toEqual(["/usr/bin/warden", "__scheduler"]);
		expect(JSON.parse(argvs[0]?.[2] ?? "")).toEqual(scheduler);
		expect(argvs[1]?.slice(0, 2)).toEqual(["/usr/bin/warden", "__route-ticker"]);
	});

	test("from source: bun runs the main scripts directly", () => {
		const { argvs, spawners } = spawned("/repo/apps/cli/src/cli.ts", "/bin/bun");
		spawners.spawnScheduler(scheduler);
		spawners.spawnTicker(ticker);
		expect(argvs[0]?.[0]).toBe(process.execPath);
		expect(argvs[0]?.[1]).toMatch(/conditions\/scheduler\.main\.ts$/);
		expect(argvs[1]?.[1]).toMatch(/conditions\/route-ticker\.main\.ts$/);
	});
});
