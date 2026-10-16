import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchAdapter } from "../adapters/adapter.types";
import { type FakeExec, fakeExec } from "./exec";
import { isolate, KNOWN_PROCESS_PATTERNS } from "./isolation";

const fx = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

const stub = (id: BenchAdapter["id"], residuePatterns: BenchAdapter["residuePatterns"]): BenchAdapter => ({
	id,
	supports: ["ios", "android"],
	doctor: async () => ({ ok: true, version: "1", notes: [] }),
	prepare: async () => ({ success: true, data: undefined }),
	run: async () => {
		throw new Error("unused");
	},
	teardown: async () => ({ success: true, data: undefined }),
	residuePatterns,
});

const next = stub("maestro", { processes: [], driverBundleIds: ["dev.mobile.maestro-driver-ios*"], dirs: [] });
const previous = stub("argent", { processes: [/oldframework/], driverBundleIds: [], dirs: [] });

function make(extra: { adbBoot?: boolean } = {}): FakeExec {
	let polls = 0;
	return fakeExec(
		[
			{ cmd: "ps", result: { stdout: `${fx("ps.txt")}  900     1   100   0.0 /bin/oldframework run\n` } },
			{ cmd: "kill", result: {} },
			{ cmd: "xcrun", match: (a) => a[1] === "listapps", result: { stdout: fx("simctl-listapps.txt") } },
			{ cmd: "xcrun", result: {} },
			{ cmd: "bun", result: {} },
			{ cmd: "argent", result: {} },
			{ cmd: "agent-device", result: {} },
			{
				cmd: "adb",
				match: (a) => a.includes("getprop"),
				result: () => ({ stdout: ++polls >= 2 || !extra.adbBoot ? "1\n" : "0\n" }),
			},
			{
				cmd: "adb",
				match: (a) => a.includes("packages"),
				result: { stdout: "package:dev.mobile.maestro-driver-ios\npackage:other\n" },
			},
			{ cmd: "adb", result: {} },
		],
		{ which: ["argent", "agent-device"] }
	);
}

const base = (exec: FakeExec) => ({
	exec,
	platform: "ios" as const,
	udid: "U",
	bundleId: "nz.co.delacour.warden.example",
	previous,
	next,
	log: () => undefined,
	repoRoot: "/repo",
	cliPath: "/repo/apps/cli/src/cli.ts",
	sleep: async () => undefined,
	cold: false,
	rebootBetween: false,
});

const cmds = (exec: FakeExec) =>
	exec.calls
		.filter((c) => c.cmd !== "ps" && !(c.cmd === "xcrun" && c.args[1] === "listapps"))
		.map((c) => [c.cmd, ...c.args].join(" "));

describe("isolate", () => {
	test("known patterns cover every framework helper", () => {
		expect(KNOWN_PROCESS_PATTERNS.some((p) => p.test("/x/warden-simd --udid U"))).toBe(true);
		expect(KNOWN_PROCESS_PATTERNS.some((p) => p.test("java -jar maestro-cli.jar"))).toBe(true);
	});

	test("ios warm: kill, stop helpers, terminate app only", async () => {
		const exec = make();
		const r = await isolate(base(exec));
		expect(cmds(exec)).toEqual([
			"kill -TERM 102 300 900",
			"kill -KILL 102 300 900",
			"bun /repo/apps/cli/src/cli.ts ui close --udid U",
			"argent server stop",
			"agent-device daemon stop --clean",
			"xcrun simctl terminate U nz.co.delacour.warden.example",
		]);
		expect(r).toEqual({
			success: true,
			data: { killed: expect.any(Array), uninstalled: [], rebooted: false },
		});
	});

	test("ios cold + reboot: uninstalls next's drivers, reboots, then terminates", async () => {
		const exec = make();
		const r = await isolate({ ...base(exec), cold: true, rebootBetween: true });
		expect(cmds(exec).slice(5)).toEqual([
			"xcrun simctl uninstall U dev.mobile.maestro-driver-iosUITests.xctrunner",
			"xcrun simctl shutdown U",
			"xcrun simctl boot U",
			"xcrun simctl bootstatus U -b",
			"xcrun simctl terminate U nz.co.delacour.warden.example",
		]);
		expect(r.success && r.data).toMatchObject({
			uninstalled: ["dev.mobile.maestro-driver-iosUITests.xctrunner"],
			rebooted: true,
		});
	});

	test("android cold + reboot polls boot_completed", async () => {
		const exec = make({ adbBoot: true });
		const r = await isolate({ ...base(exec), platform: "android", udid: "emu-1", cold: true, rebootBetween: true });
		const list = cmds(exec);
		expect(list).toContain("adb -s emu-1 uninstall dev.mobile.maestro-driver-ios");
		expect(list.slice(list.indexOf("adb -s emu-1 reboot"))).toEqual([
			"adb -s emu-1 reboot",
			"adb -s emu-1 wait-for-device",
			"adb -s emu-1 shell getprop sys.boot_completed",
			"adb -s emu-1 shell getprop sys.boot_completed",
			"adb -s emu-1 shell am force-stop nz.co.delacour.warden.example",
		]);
		expect(r.success).toBe(true);
	});

	test("android warm: no uninstall, no reboot", async () => {
		const exec = make();
		await isolate({ ...base(exec), platform: "android", udid: "emu-1" });
		expect(cmds(exec).at(-1)).toBe("adb -s emu-1 shell am force-stop nz.co.delacour.warden.example");
		expect(cmds(exec).some((c) => c.includes("reboot") || c.includes("uninstall"))).toBe(false);
	});

	test("reboot failure is an error", async () => {
		const exec = fakeExec([
			{ cmd: "ps", result: { stdout: fx("ps.txt") } },
			{ cmd: "xcrun", match: (a) => a[1] === "boot", result: { code: 1, stderr: "boom" } },
		]);
		const r = await isolate({ ...base(exec), rebootBetween: true });
		expect(r).toEqual({ success: false, error: "simctl boot failed: boom" });
	});
});
