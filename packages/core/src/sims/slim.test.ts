import { describe, expect, test } from "bun:test";
import type { Exec, ExecResult } from "../exec";
import {
	NEVER_DISABLE,
	parseLaunchctlList,
	parsePrintDisabled,
	planHeal,
	planRestore,
	planSlim,
	SLIM_CONCURRENCY,
	SLIM_RETIRED,
	slimSimulator,
} from "./slim";
import { DEFAULT_SLIM_PROFILE, desiredLabels } from "./slim.profile";

const DENYLIST = [...desiredLabels(DEFAULT_SLIM_PROFILE)];

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

describe("default profile labels", () => {
	test("every label is an Apple launchd label, listed once", () => {
		for (const label of DENYLIST) expect(label).toMatch(/^com\.apple\.[\w.-]+$/);
		expect(new Set(DENYLIST).size).toBe(DENYLIST.length);
	});

	test("never touches what SpringBoard, installs, the e2e driver's AX tree or typing need", () => {
		for (const label of DENYLIST) {
			for (const pattern of NEVER_DISABLE) expect(pattern.test(label)).toBe(false);
		}
	});
});

describe("warden-simd's HID + AX bridge services", () => {
	test("are protected by NEVER_DISABLE, so a denylist entry for them cannot slip in", () => {
		const needed = [
			"dtuhidd",
			"com.apple.dtuhidd",
			"SimulatorFrameworkBridge-iOS",
			"com.apple.SimulatorFrameworkBridge-iOS",
			"com.apple.axbridge.service",
			"com.apple.Accessibility",
			"com.apple.accessibility.AccessibilityUIServer",
			"com.apple.AccessibilityUIServer",
		];
		for (const label of needed) {
			expect(NEVER_DISABLE.some((pattern) => pattern.test(label))).toBe(true);
			expect(DENYLIST).not.toContain(label);
		}
	});
});

describe("dictation daemons (the keyboard hangs the app without them)", () => {
	test("are never disabled, and a sim an older denylist slimmed gets them back", () => {
		for (const label of ["com.apple.assistantd", "com.apple.corespeechd"]) {
			expect(DENYLIST).not.toContain(label);
			expect(SLIM_RETIRED).toContain(label);
			expect(NEVER_DISABLE.some((pattern) => pattern.test(label))).toBe(true);
		}
		const disabled = new Map([
			["com.apple.assistantd", true],
			["com.apple.corespeechd", false],
			["com.apple.newsd", true],
		]);
		expect(planHeal(disabled)).toEqual(["com.apple.assistantd"]);
		expect(planRestore(disabled)).toEqual(["com.apple.newsd", "com.apple.assistantd"]);
	});
});

describe("retired labels", () => {
	test("gamed and nanotimekitcompaniond are never disabled and get re-enabled on a sim an older slim hit", () => {
		for (const label of ["com.apple.gamed", "com.apple.nanotimekitcompaniond"]) {
			expect(DENYLIST).not.toContain(label);
			expect(SLIM_RETIRED).toContain(label);
		}
		const disabled = new Map([
			["com.apple.gamed", true],
			["com.apple.nanotimekitcompaniond", true],
		]);
		expect(planHeal(disabled)).toEqual(["com.apple.gamed", "com.apple.nanotimekitcompaniond"]);
		expect(planRestore(disabled)).toEqual(["com.apple.gamed", "com.apple.nanotimekitcompaniond"]);
	});

	test("chronod is no longer protected", () => {
		expect(NEVER_DISABLE.some((pattern) => pattern.test("com.apple.chronod"))).toBe(false);
		expect(DENYLIST).toContain("com.apple.chronod");
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

	test("a profile's excepted category is left alone", async () => {
		const calls: string[][] = [];
		const res = await slimSimulator(fake(calls), "U1", {
			profile: { except: ["health"], keep: ["com.apple.remindd"] },
		});
		expect(res.success && res.data).not.toContain("com.apple.healthd");
		expect(res.success && res.data).not.toContain("com.apple.remindd");
		expect(spawned(calls)).not.toContain("disable system/com.apple.healthd");
		expect(spawned(calls)).toContain("disable system/com.apple.photoanalysisd");
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

	describe("concurrency", () => {
		const everything = DENYLIST.map((label) => `\t"${label}" => disabled`).join("\n");
		const running = `PID\tStatus\tLabel\n${DENYLIST.map((label, i) => `${100 + i}\t0\t${label}`).join("\n")}`;

		/** Exec that records how many `launchctl enable|disable|bootout` are in flight at once. */
		function gauge(failOn?: string) {
			const stats = { inFlight: 0, peak: 0, started: [] as string[] };
			const exec: Exec = async (cmd) => {
				const verb = cmd[5] ?? "";
				const key = cmd.slice(5).join(" ");
				if (verb === "print-disabled") return { exitCode: 0, stdout: everything, stderr: "" };
				if (verb === "list") return { exitCode: 0, stdout: running, stderr: "" };
				stats.started.push(key);
				stats.inFlight++;
				stats.peak = Math.max(stats.peak, stats.inFlight);
				await Bun.sleep(2);
				stats.inFlight--;
				return key === failOn ? { exitCode: 1, stdout: "", stderr: "boom" } : { exitCode: 0, stdout: "", stderr: "" };
			};
			return { exec, stats };
		}

		test("slimming runs the per-job spawns in parallel, never more than SLIM_CONCURRENCY at once", async () => {
			const { exec, stats } = gauge();
			const res = await slimSimulator(exec, "U1");
			expect(res.success && res.data).toEqual([...DENYLIST]);
			expect(stats.started).toHaveLength(DENYLIST.length * 2);
			expect(stats.peak).toBeGreaterThan(1);
			expect(stats.peak).toBeLessThanOrEqual(SLIM_CONCURRENCY);
		});

		test("restoring is bounded the same way and re-enables everything", async () => {
			const { exec, stats } = gauge();
			const res = await slimSimulator(exec, "U1", { restore: true });
			expect(res.success && res.data).toEqual([...DENYLIST]);
			expect(stats.started).toHaveLength(DENYLIST.length);
			expect(stats.peak).toBeGreaterThan(1);
			expect(stats.peak).toBeLessThanOrEqual(SLIM_CONCURRENCY);
		});

		test("a failing disable stops new jobs from starting and is the error returned", async () => {
			const first = DENYLIST[0] as string;
			const { exec, stats } = gauge(`disable system/${first}`);
			const res = await slimSimulator(exec, "U1");
			expect(res.success).toBe(false);
			if (!res.success) expect(res.error).toContain("boom");
			expect(stats.started.filter((s) => s.startsWith("disable")).length).toBeLessThanOrEqual(SLIM_CONCURRENCY);
		});

		test("a fresh sim: every label is disabled, only the loaded ones are booted out (2 + N + 10 spawns, 16-12)", async () => {
			const loaded = DENYLIST.slice(0, 10);
			const calls: string[][] = [];
			const exec: Exec = async (cmd) => {
				calls.push([...cmd]);
				const verb = cmd[5];
				const stdout =
					verb === "list"
						? `PID\tStatus\tLabel\n${loaded.map((label, i) => `${100 + i}\t0\t${label}`).join("\n")}`
						: "";
				return { exitCode: 0, stdout, stderr: "" };
			};
			const res = await slimSimulator(exec, "U1");
			expect(res.success && res.data).toEqual([...DENYLIST]);
			expect(calls).toHaveLength(2 + DENYLIST.length + loaded.length);
			const bootedOut = calls.filter((c) => c[5] === "bootout").map((c) => c[6]);
			expect(bootedOut.sort()).toEqual(loaded.map((label) => `system/${label}`).sort());
		});

		test("each job is disabled before it is booted out", async () => {
			const { exec, stats } = gauge();
			await slimSimulator(exec, "U1");
			for (const label of DENYLIST) {
				expect(stats.started.indexOf(`disable system/${label}`)).toBeLessThan(
					stats.started.indexOf(`bootout system/${label}`)
				);
			}
		});
	});
});
