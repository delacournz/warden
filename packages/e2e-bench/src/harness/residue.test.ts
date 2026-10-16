import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResiduePatterns } from "../adapters/adapter.types";
import { fakeExec } from "./exec";
import {
	checkResidue,
	killMatching,
	listDriverApps,
	matchesBundle,
	parsePmList,
	parseSimctlListApps,
	snapshotResidue,
} from "./residue";

const fx = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

const patterns: ResiduePatterns = {
	processes: [/maestro/, /warden-simd/],
	driverBundleIds: ["dev.mobile.maestro-driver-ios*", "com.facebook.WebDriverAgentRunner.xctrunner"],
	dirs: ["~/.maestro"],
};

describe("parsers", () => {
	test("simctl listapps", () => {
		expect(parseSimctlListApps(fx("simctl-listapps.txt"))).toEqual([
			"com.apple.mobilesafari",
			"nz.co.delacour.warden.example",
			"com.facebook.WebDriverAgentRunner.xctrunner",
			"dev.mobile.maestro-driver-iosUITests.xctrunner",
		]);
	});
	test("pm list packages", () => {
		expect(parsePmList("package:com.a\npackage:dev.mobile.maestro\n\n")).toEqual(["com.a", "dev.mobile.maestro"]);
	});
	test("glob", () => {
		expect(matchesBundle("a.b.c", "a.b*")).toBe(true);
		expect(matchesBundle("a.b.c", "a.b")).toBe(false);
	});
});

describe("listDriverApps", () => {
	test("ios filters by globs", async () => {
		const exec = fakeExec([{ cmd: "xcrun", result: { stdout: fx("simctl-listapps.txt") } }]);
		expect(await listDriverApps(exec, "ios", "U", patterns.driverBundleIds)).toEqual([
			"com.facebook.WebDriverAgentRunner.xctrunner",
			"dev.mobile.maestro-driver-iosUITests.xctrunner",
		]);
		expect(exec.calls[0]?.args).toEqual(["simctl", "listapps", "U"]);
	});
	test("android uses pm list packages", async () => {
		const exec = fakeExec([{ cmd: "adb", result: { stdout: "package:dev.mobile.maestro-driver-ios\npackage:x.y\n" } }]);
		expect(await listDriverApps(exec, "android", "emu-1", patterns.driverBundleIds)).toEqual([
			"dev.mobile.maestro-driver-ios",
		]);
		expect(exec.calls[0]?.args).toEqual(["-s", "emu-1", "shell", "pm", "list", "packages"]);
	});
});

describe("checkResidue", () => {
	test("processes, apps and dir deltas vs before; self and ancestors excluded", async () => {
		let du = 100;
		const exec = fakeExec([
			{ cmd: "ps", result: { stdout: fx("ps.txt") } },
			{ cmd: "xcrun", result: { stdout: fx("simctl-listapps.txt") } },
			{ cmd: "du", result: () => ({ stdout: `${du}\t/home/u/.maestro\n` }) },
		]);
		const input = { exec, platform: "ios" as const, udid: "U", patterns, home: "/home/u", selfPid: 100 };
		const before = await snapshotResidue(input);
		expect(before.dirKb).toEqual({ "/home/u/.maestro": 100 });
		du = 150;
		const r = await checkResidue({ ...input, before });
		// selfPid 100 and its ancestors are never reported
		expect(r.processes).toEqual([
			"102 /Users/x/bin/warden-simd --udid AAAA-BBBB",
			"300 /opt/homebrew/bin/java -jar maestro-cli.jar",
		]);
		expect(r.driverApps).toHaveLength(2);
		expect(r.paths).toEqual([{ path: "/home/u/.maestro", deltaBytes: 50 * 1024 }]);
	});

	test("absent dir reports nothing", async () => {
		const exec = fakeExec([
			{ cmd: "ps", result: { stdout: fx("ps.txt") } },
			{ cmd: "du", result: { code: 1, stderr: "No such file" } },
		]);
		const r = await checkResidue({ exec, platform: "ios", udid: "U", patterns, home: "/h", selfPid: 1 });
		expect(r.paths).toEqual([]);
	});
});

describe("killMatching", () => {
	test("TERM, wait, KILL survivors", async () => {
		const exec = fakeExec([
			{ cmd: "ps", result: { stdout: fx("ps.txt") } },
			{ cmd: "kill", result: {} },
		]);
		const slept: number[] = [];
		const killed = await killMatching(exec, [/maestro/], { sleep: async (ms) => void slept.push(ms), selfPid: 1 });
		expect(killed).toEqual(["300 /opt/homebrew/bin/java -jar maestro-cli.jar"]);
		expect(slept).toEqual([3000]);
		const kills = exec.calls.filter((c) => c.cmd === "kill").map((c) => c.args);
		expect(kills).toEqual([
			["-TERM", "300"],
			["-KILL", "300"],
		]);
	});

	test("nothing matched = no kill", async () => {
		const exec = fakeExec([{ cmd: "ps", result: { stdout: fx("ps.txt") } }]);
		expect(await killMatching(exec, [/nomatch/])).toEqual([]);
		expect(exec.calls.some((c) => c.cmd === "kill")).toBe(false);
	});
});
