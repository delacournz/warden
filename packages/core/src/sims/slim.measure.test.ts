import { describe, expect, test } from "bun:test";
import type { Exec, ExecResult } from "../exec";
import { measureSim, measureSims, measureTree, parseMemUnit, parsePs, parseTopMem, treePids } from "./slim.measure";

const MB = 1024 ** 2;

const PS = [
	"  PID  PPID COMM",
	"    1     0 /sbin/launchd",
	"  100     1 /Library/Developer/CoreSimulator/Volumes/iOS/RuntimeRoot/sbin/launchd_sim",
	"  101   100 /Library/Developer/CoreSimulator/Volumes/iOS/RuntimeRoot/usr/libexec/backboardd",
	"  102   101 /Applications/MyApp.app/MyApp",
	"  200     1 /sbin/launchd_sim",
	"  201   200 /usr/libexec/otherd",
	"",
].join("\n");

const TOP = [
	"Processes: 500 total",
	"PID    MEM",
	"1      4M",
	"100    2M+",
	"101    168M",
	"102    1.2G",
	"200    10M",
	"201    1024K-",
	"",
].join("\n");

describe("parseMemUnit", () => {
	test("units and suffixes", () => {
		expect(parseMemUnit("168M+")).toBe(168 * MB);
		expect(parseMemUnit("1024K")).toBe(1024 * 1024);
		expect(parseMemUnit("1.2G")).toBe(Math.round(1.2 * 1024 ** 3));
		expect(parseMemUnit("12B")).toBe(12);
		expect(parseMemUnit("2M-")).toBe(2 * MB);
	});
	test("garbage is undefined", () => {
		expect(parseMemUnit("abc")).toBeUndefined();
		expect(parseMemUnit("")).toBeUndefined();
	});
});

describe("parsePs / parseTopMem", () => {
	test("ps rows keep basename of comm", () => {
		const snap = parsePs(PS);
		expect(snap.get(102)).toEqual({ pid: 102, ppid: 101, command: "MyApp" });
		expect(snap.size).toBe(6);
	});
	test("top skips headers", () => {
		const mem = parseTopMem(TOP);
		expect(mem.get(101)).toBe(168 * MB);
		expect(mem.get(201)).toBe(1024 * 1024);
		expect(mem.has(0)).toBe(false);
	});
});

describe("treePids / measureTree", () => {
	test("follows children transitively", () => {
		expect(treePids(100, parsePs(PS)).sort()).toEqual([100, 101, 102]);
	});
	test("sums footprint and sorts top by bytes", () => {
		const m = measureTree(100, parsePs(PS), parseTopMem(TOP));
		expect(m.processes).toBe(3);
		expect(m.footprintBytes).toBe(2 * MB + 168 * MB + Math.round(1.2 * 1024 ** 3));
		expect(m.top.map((t) => t.command)).toEqual(["MyApp", "backboardd", "launchd_sim"]);
	});
	test("process missing from top counts as 0", () => {
		const m = measureTree(200, parsePs(PS), new Map());
		expect(m.processes).toBe(2);
		expect(m.footprintBytes).toBe(0);
	});
});

function exec(pgrepByUdid: Record<string, string>): { exec: Exec; calls: string[] } {
	const calls: string[] = [];
	const run: Exec = async (cmd) => {
		const line = cmd.join(" ");
		calls.push(line);
		const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
		if (cmd[0] === "pgrep") {
			const udid = Object.keys(pgrepByUdid).find((u) => line.includes(u));
			return udid === undefined ? { exitCode: 1, stdout: "", stderr: "" } : ok(pgrepByUdid[udid] ?? "");
		}
		if (cmd[0] === "ps") return ok(PS);
		if (cmd[0] === "top") return ok(TOP);
		return { exitCode: 127, stdout: "", stderr: "?" };
	};
	return { exec: run, calls };
}

describe("measureSim", () => {
	test("measures the tree under the first pgrep pid", async () => {
		const { exec: run } = exec({ A: "100\n999\n" });
		const res = await measureSim(run, "A");
		expect(res).toMatchObject({ success: true, data: { udid: "A", processes: 3 } });
	});
	test("not booted when pgrep finds nothing", async () => {
		const { exec: run } = exec({});
		expect(await measureSim(run, "A")).toEqual({ success: false, error: "A: not booted" });
	});
});

describe("measureSims", () => {
	test("one ps and one top for all sims", async () => {
		const { exec: run, calls } = exec({ A: "100", B: "200" });
		const res = await measureSims(run, ["A", "B", "C"]);
		expect(calls.filter((c) => c.startsWith("ps")).length).toBe(1);
		expect(calls.filter((c) => c.startsWith("top")).length).toBe(1);
		expect(res.get("A")).toMatchObject({ success: true });
		expect(res.get("B")).toMatchObject({ success: true, data: { processes: 2 } });
		expect(res.get("C")).toMatchObject({ success: false });
	});
	test("no booted sims runs no ps/top", async () => {
		const { exec: run, calls } = exec({});
		await measureSims(run, ["C"]);
		expect(calls.some((c) => c.startsWith("ps") || c.startsWith("top"))).toBe(false);
	});
});
