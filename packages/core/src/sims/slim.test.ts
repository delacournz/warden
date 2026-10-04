import { describe, expect, test } from "bun:test";
import type { Exec, ExecResult } from "../exec";
import {
	NEVER_DISABLE,
	parseLaunchctlList,
	parsePrintDisabled,
	planRestore,
	planSlim,
	SLIM_DENYLIST,
	slimSimulator,
} from "./slim";

const LIST = [
	"PID\tStatus\tLabel",
	"-\t0\tcom.apple.progressd",
	"14222\t0\tcom.apple.healthd",
	"-\t0\tcom.apple.newsd",
	"15005\t0\tcom.apple.email.maild",
	"401\t0\tUIKitApplication:com.apple.Spotlight[74c8][rb-legacy]",
	"",
].join("\n");

const DISABLED = [
	"",
	"\tdisabled services = {",
	'\t\t"com.apple.nanonewscd" => enabled',
	'\t\t"com.apple.newsd" => disabled',
	"\t}",
	"",
].join("\n");

describe("SLIM_DENYLIST", () => {
	test("every label is an Apple launchd label, listed once", () => {
		for (const label of SLIM_DENYLIST) expect(label).toMatch(/^com\.apple\.[\w.]+$/);
		expect(new Set(SLIM_DENYLIST).size).toBe(SLIM_DENYLIST.length);
	});

	test("never touches what SpringBoard, installs, argent's AX tree or typing need", () => {
		for (const label of SLIM_DENYLIST) {
			for (const pattern of NEVER_DISABLE) expect(pattern.test(label)).toBe(false);
		}
	});
});

describe("parsers + plans", () => {
	test("parseLaunchctlList: pid, - for not running, blank lines dropped", () => {
		expect(parseLaunchctlList(LIST).slice(0, 3)).toEqual([
			{ label: "com.apple.progressd", pid: null },
			{ label: "com.apple.healthd", pid: 14222 },
			{ label: "com.apple.newsd", pid: null },
		]);
	});

	test("parsePrintDisabled: label → disabled", () => {
		expect(parsePrintDisabled(DISABLED)).toEqual(
			new Map([
				["com.apple.nanonewscd", false],
				["com.apple.newsd", true],
			])
		);
	});

	test("planSlim skips disabled-and-stopped jobs; planRestore lists the disabled ones", () => {
		const plan = planSlim(parseLaunchctlList(LIST), parsePrintDisabled(DISABLED));
		expect(plan).toContain("com.apple.healthd");
		expect(plan).not.toContain("com.apple.newsd");
		expect(planRestore(parsePrintDisabled(DISABLED))).toEqual(["com.apple.newsd"]);
	});
});

describe("slimSimulator", () => {
	const fake = (calls: string[][], overrides: Record<string, Partial<ExecResult>> = {}): Exec => {
		return async (cmd) => {
			calls.push([...cmd]);
			const key = cmd.slice(4, 6).join(" ");
			const base: Record<string, string> = { "launchctl print-disabled": DISABLED, "launchctl list": LIST };
			return { exitCode: 0, stdout: base[key] ?? "", stderr: "", ...overrides[key] };
		};
	};
	const spawned = (calls: string[][]) => calls.map((c) => c.slice(5).join(" "));

	test("disables + boots out what is left; a dry run only plans", async () => {
		const calls: string[][] = [];
		const res = await slimSimulator(fake(calls), "U1");
		expect(res.success && res.data).toContain("com.apple.healthd");
		const cmds = spawned(calls);
		expect(cmds).toContain("disable system/com.apple.healthd");
		expect(cmds).toContain("bootout system/com.apple.healthd");
		expect(cmds).not.toContain("disable system/com.apple.newsd");

		const dry: string[][] = [];
		const planned = await slimSimulator(fake(dry), "U1", { dryRun: true });
		expect(planned.success && planned.data.length).toBeGreaterThan(0);
		expect(spawned(dry).some((c) => c.startsWith("disable"))).toBe(false);
	});

	test("restore re-enables only the disabled denylisted jobs", async () => {
		const calls: string[][] = [];
		const res = await slimSimulator(fake(calls), "U1", { restore: true });
		expect(res).toEqual({ success: true, data: ["com.apple.newsd"] });
		expect(spawned(calls)).toContain("enable system/com.apple.newsd");
	});

	test("a failing launchctl is an error result, never a throw", async () => {
		const failing = fake([], { "launchctl print-disabled": { exitCode: 1, stderr: "not booted" } });
		const res = await slimSimulator(failing, "U1");
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("not booted");
	});
});
