import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePs } from "@delacour/warden-perf/metrics/ps";
import type { ResiduePatterns } from "../adapters/adapter.types";
import { fakeExec } from "./exec";
import {
	checkResidue,
	killMatching,
	listDriverApps,
	listMatchingProcesses,
	matchesBundle,
	type Owner,
	ownerFilter,
	parsePmList,
	parseSimctlListApps,
	snapshotResidue,
} from "./residue";

const fx = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

const owner: Owner = {
	udid: "AAAA-BBBB",
	benchPids: () => [100, 300],
	ownedPaths: ["/Users/x/.agent-device-bench"],
};

const patterns: ResiduePatterns = {
	processes: [/helper/, /warden-simd/, /daemon/, /simulator-server/, /xcodebuild/],
	driverBundleIds: ["com.example.driver-ios*", "com.facebook.WebDriverAgentRunner.xctrunner"],
	dirs: ["~/.helperdir"],
};

describe("parsers", () => {
	test("simctl listapps", () => {
		expect(parseSimctlListApps(fx("simctl-listapps.txt"))).toEqual([
			"com.apple.mobilesafari",
			"nz.co.delacour.warden.example",
			"com.facebook.WebDriverAgentRunner.xctrunner",
			"com.example.driver-iosUITests.xctrunner",
		]);
	});
	test("pm list packages", () => {
		expect(parsePmList("package:com.a\npackage:com.example.driver\n\n")).toEqual(["com.a", "com.example.driver"]);
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
			"com.example.driver-iosUITests.xctrunner",
		]);
		expect(exec.calls[0]?.args).toEqual(["simctl", "listapps", "U"]);
	});
	test("android uses pm list packages", async () => {
		const exec = fakeExec([{ cmd: "adb", result: { stdout: "package:com.example.driver-ios\npackage:x.y\n" } }]);
		expect(await listDriverApps(exec, "android", "emu-1", patterns.driverBundleIds)).toEqual([
			"com.example.driver-ios",
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
			{ cmd: "du", result: () => ({ stdout: `${du}\t/home/u/.helperdir\n` }) },
		]);
		const input = { exec, platform: "ios" as const, udid: "U", patterns, owner, home: "/home/u", selfPid: 100 };
		const before = await snapshotResidue(input);
		expect(before.dirKb).toEqual({ "/home/u/.helperdir": 100 });
		du = 150;
		const r = await checkResidue({ ...input, before });
		// selfPid 100 and its ancestors are never reported
		expect(r.processes).toEqual([
			"102 /Users/x/bin/warden-simd --udid AAAA-BBBB",
			"300 /opt/homebrew/bin/java -jar helper-cli.jar",
			"600 /Users/x/.agent-device-bench/agent-device/daemon.js --state",
		]);
		expect(r.driverApps).toHaveLength(2);
		expect(r.paths).toEqual([{ path: "/home/u/.helperdir", deltaBytes: 50 * 1024 }]);
	});

	test("absent dir reports nothing", async () => {
		const exec = fakeExec([
			{ cmd: "ps", result: { stdout: fx("ps.txt") } },
			{ cmd: "du", result: { code: 1, stderr: "No such file" } },
		]);
		const r = await checkResidue({ exec, platform: "ios", udid: "U", patterns, owner, home: "/h", selfPid: 1 });
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
		const killed = await killMatching(exec, [/helper/], owner, {
			sleep: async (ms) => void slept.push(ms),
			selfPid: 1,
		});
		expect(killed).toEqual(["300 /opt/homebrew/bin/java -jar helper-cli.jar"]);
		expect(slept).toEqual([3000]);
		const kills = exec.calls.filter((c) => c.cmd === "kill").map((c) => c.args);
		expect(kills).toEqual([
			["-TERM", "300"],
			["-KILL", "300"],
		]);
	});

	test("nothing matched = no kill", async () => {
		const exec = fakeExec([{ cmd: "ps", result: { stdout: fx("ps.txt") } }]);
		expect(await killMatching(exec, [/nomatch/], owner)).toEqual([]);
		expect(exec.calls.some((c) => c.cmd === "kill")).toBe(false);
	});
});

describe("ownerFilter", () => {
	const rows = parsePs(fx("ps.txt"));
	const pids = (o: Owner) => ownerFilter(rows, o).map((r) => r.pid);

	test("udid match, bench-pid trees and owned paths are ours; foreign helpers are not", () => {
		expect(pids(owner)).toEqual([100, 101, 102, 200, 201, 202, 300, 600]);
		for (const foreign of [500, 501, 502, 503]) expect(pids(owner)).not.toContain(foreign);
	});

	test("nothing owned means nothing returned", () => {
		expect(pids({ benchPids: () => [], ownedPaths: [] })).toEqual([]);
	});

	test("a foreign udid is owned only when it is ours", () => {
		expect(pids({ udid: "1A0EC51B-FOREIGN", benchPids: () => [], ownedPaths: [] })).toEqual([500, 502]);
	});
});

describe("killMatching ownership", () => {
	test("never kills a foreign session's matching helpers", async () => {
		const exec = fakeExec([
			{ cmd: "ps", result: { stdout: fx("ps.txt") } },
			{ cmd: "kill", result: {} },
		]);
		const killed = await killMatching(exec, [/simulator-server/, /daemon/, /tool-server/, /xcodebuild/], owner, {
			sleep: async () => undefined,
			selfPid: 1,
		});
		expect(killed).toEqual(["600 /Users/x/.agent-device-bench/agent-device/daemon.js --state"]);
	});
});

describe("listMatchingProcesses never matches shells", () => {
	const udid = "AAAA-BBBB";
	const own: Owner = { udid, benchPids: () => [], ownedPaths: [] };
	const psOut = (...rows: string[]) =>
		`  PID  PPID    RSS  %CPU COMMAND\n${rows.map((r, i) => `  ${900 + i}     1  1000   0.0 ${r}`).join("\n")}\n`;
	const list = async (patterns: RegExp[], ...rows: string[]) =>
		(await listMatchingProcesses(fakeExec([{ cmd: "ps", result: { stdout: psOut(...rows) } }]), patterns, own, 1)).map(
			(p) => p.line
		);

	test("an owned zsh watcher mentioning the helper and udid is owned but not listed", async () => {
		const row = `/bin/zsh -c while true; do warden-simd --udid ${udid}; done`;
		const rows = parsePs(psOut(row));
		expect(ownerFilter(rows, own).map((r) => r.pid)).toEqual([900]);
		expect(await list([/warden-simd/], row)).toEqual([]);
	});

	test("a real helper binary is still listed", async () => {
		const row = `/opt/warden/bin/warden-simd --udid ${udid}`;
		expect(await list([/warden-simd/], row)).toEqual([`900 ${row}`]);
	});

	test("a node script helper is still listed", async () => {
		const row = `node /x/argent/simulator-server.js ${udid}`;
		expect(await list([/argent.*(simulator-server|tool-server)/], row)).toEqual([`900 ${row}`]);
	});

	test("sh -c wrapper is skipped while its warden-simd child is listed", async () => {
		const out = `  PID  PPID    RSS  %CPU COMMAND\n  900     1  1000   0.0 /bin/sh -c /path/warden-simd ${udid}\n  901   900  1000   0.0 /path/warden-simd ${udid}\n`;
		const exec = fakeExec([{ cmd: "ps", result: { stdout: out } }]);
		const found = await listMatchingProcesses(exec, [/warden-simd/], own, 1);
		expect(found.map((p) => p.pid)).toEqual([901]);
	});

	test("env, nohup, caffeinate and every shell are skipped", async () => {
		const names = ["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "env", "nohup", "caffeinate"];
		const rows = names.map((n) => `/usr/bin/${n} warden-simd ${udid}`);
		expect(await list([/warden-simd/], ...rows)).toEqual([]);
	});

	test("a login shell dash prefix is skipped", async () => {
		expect(await list([/warden-simd/], `-zsh warden-simd ${udid}`)).toEqual([]);
	});
});
