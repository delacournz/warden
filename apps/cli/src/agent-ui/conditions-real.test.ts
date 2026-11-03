import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "@delacour/warden-core/exec";
import { androidUiCamera, conditionSpawners } from "./conditions-real";

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

describe("androidUiCamera", () => {
	test("drives the emulator camera like the full driver: a device warden did not claim with --camera is E_CAMERA_DEVICE", async () => {
		const home = mkdtempSync(join(tmpdir(), "warden-ui-cam-"));
		const img = join(home, "a.png");
		writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		const calls: string[][] = [];
		const exec: Exec = async (argv) => {
			calls.push([...argv]);
			return { exitCode: 0, stdout: "", stderr: "" };
		};
		const camera = await androidUiCamera({ serial: "emulator-5554", env: { WARDEN_HOME: home }, exec });
		const res = await camera({ back: { kind: "image", path: img } });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error.code).toBe("E_CAMERA_DEVICE");
		expect(calls).toEqual([]);
		rmSync(home, { recursive: true, force: true });
	});
});
