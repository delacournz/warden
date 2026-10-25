import { describe, expect, test } from "bun:test";
import type { Exec, ExecResult } from "../exec";
import {
	NEVER_DISABLE,
	parseLaunchctlList,
	parsePrintDisabled,
	planHeal,
	planRestore,
	planSlim,
	SLIM_BATCH_SIZE,
	SLIM_CONCURRENCY,
	SLIM_RETIRED,
	slimSimulator,
	slimSimulatorReport,
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

const RT = "com.apple.CoreSimulator.SimRuntime.iOS-27-1";
const ROOT = "/rt/RuntimeRoot";
const plistOf = (label: string) => `${ROOT}/System/Library/LaunchDaemons/${label}.plist`;

type HostOptions = {
	disabled?: string[];
	loaded?: string[];
	/** labels whose plist exists; default none (runtime root unknown → per-label path) */
	plists?: string[];
	/** plist path → the Label inside it, when it differs from the file name */
	plistLabel?: Record<string, string>;
	noRuntime?: boolean;
	/** launchctl verbs (`print-disabled`, `disable system/x`, …) answered with a scripted result, once each in order */
	script?: Record<string, ExecResult[]>;
	/** a `disable system/x` that never takes */
	stuck?: string[];
};

/** Stateful fake simctl host: launchctl keeps a disabled set and a loaded set, `unload -w` / `disable` / `bootout` act on them. */
function host(options: HostOptions = {}) {
	const disabled = new Set(options.disabled ?? []);
	const loaded = new Set(options.loaded ?? []);
	const plists = new Map((options.plists ?? []).map((label) => [plistOf(label), label]));
	const calls: string[][] = [];
	const script = options.script ?? {};
	const ok0 = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
	const applyBatch = (verb: "unload" | "load", paths: string[]): void => {
		for (const path of paths) {
			const label = plists.get(path);
			if (label === undefined) continue;
			if (verb === "unload") disabled.add(label);
			else disabled.delete(label);
			if (verb === "unload") loaded.delete(label);
			else loaded.add(label);
		}
	};
	const mutate = (verb: string, rest: string[]): void => {
		const label = (rest[0] ?? "").replace("system/", "");
		if (verb === "unload" || verb === "load") applyBatch(verb, rest.slice(1));
		if (verb === "disable" && !options.stuck?.includes(label)) disabled.add(label);
		if (verb === "enable") disabled.delete(label);
		if (verb === "bootout") loaded.delete(label);
		if (verb === "bootstrap") loaded.add(plists.get(rest[1] ?? "") ?? "");
	};
	const launchctlVerb = (verb: string, rest: string[]): ExecResult => {
		if (verb === "print-disabled") return ok0([...disabled].map((label) => `\t\t"${label}" => disabled`).join("\n"));
		if (verb === "list") {
			return ok0(`PID\tStatus\tLabel\n${[...loaded].map((l, i) => `${100 + i}\t0\t${l}`).join("\n")}`);
		}
		mutate(verb, rest);
		return ok0();
	};
	const simctlList = (what: string | undefined): ExecResult => {
		if (what === "devices") return ok0(JSON.stringify({ devices: { [RT]: [{ udid: "U1" }] } }));
		return options.noRuntime ? ok0("{}") : ok0(JSON.stringify({ runtimes: [{ identifier: RT, runtimeRoot: ROOT }] }));
	};
	const exec: Exec = async (cmd) => {
		calls.push([...cmd]);
		if (cmd[0] === "plutil") {
			const path = cmd[cmd.length - 1] as string;
			return ok0(options.plistLabel?.[path] ?? plists.get(path) ?? "");
		}
		if (cmd[2] === "list") return simctlList(cmd[3]);
		const verb = cmd[5] ?? "";
		const rest = cmd.slice(6);
		const key = [verb, ...rest].join(" ");
		const scripted = script[verb] ?? script[key];
		const next = scripted?.shift();
		if (next !== undefined) return next;
		return launchctlVerb(verb, rest);
	};
	const spawned = () => calls.filter((c) => c[1] === "simctl" && c[2] === "spawn").map((c) => c.slice(5));
	const verbs = (verb: string) => spawned().filter((c) => c[0] === verb);
	return { exec, calls, spawned, verbs, disabled, loaded };
}

const fast = { sleep: async () => {}, fileExists: () => true };
const sleeps = () => {
	const waited: number[] = [];
	return { waited, sleep: async (ms: number) => void waited.push(ms) };
};

describe("slimSimulator", () => {
	test("disables + boots out what is left; a loaded-but-disabled job is unloaded too; a dry run only reads", async () => {
		const h = host({ disabled: ["com.apple.newsd"], loaded: ["com.apple.healthd", "com.apple.newsd"] });
		const res = await slimSimulator(h.exec, "U1", fast);
		expect(res.success && res.data).toContain("com.apple.healthd");
		expect(res.success && res.data).toContain("com.apple.newsd");
		const cmds = h.spawned().map((c) => c.join(" "));
		expect(cmds).toContain("disable system/com.apple.healthd");
		expect(cmds).toContain("bootout system/com.apple.healthd");
		expect(cmds).toContain("bootout system/com.apple.newsd");
		expect(h.loaded.size).toBe(0);

		const dry = host({ loaded: ["com.apple.healthd"] });
		const planned = await slimSimulator(dry.exec, "U1", { ...fast, dryRun: true });
		expect(planned.success && planned.data.length).toBeGreaterThan(0);
		expect(
			dry
				.spawned()
				.map((c) => c[0])
				.sort()
		).toEqual(["list", "print-disabled"]);
	});

	test("a profile's excepted category is left alone", async () => {
		const h = host();
		const res = await slimSimulator(h.exec, "U1", {
			...fast,
			profile: { except: ["health"], keep: ["com.apple.remindd"] },
		});
		expect(res.success && res.data).not.toContain("com.apple.healthd");
		expect(res.success && res.data).not.toContain("com.apple.remindd");
		const cmds = h.spawned().map((c) => c.join(" "));
		expect(cmds).not.toContain("disable system/com.apple.healthd");
		expect(cmds).toContain("disable system/com.apple.photoanalysisd");
	});

	test("restore re-enables only the disabled denylisted jobs", async () => {
		const h = host({ disabled: ["com.apple.newsd", "com.apple.notmine"] });
		const res = await slimSimulator(h.exec, "U1", { ...fast, restore: true });
		expect(res).toEqual({ success: true, data: ["com.apple.newsd"] });
		expect(h.verbs("enable")).toEqual([["enable", "system/com.apple.newsd"]]);
		expect(h.disabled.has("com.apple.notmine")).toBe(true);
	});

	test("a failing launchctl is an error result, never a throw", async () => {
		const h = host({ script: { "print-disabled": [{ exitCode: 1, stdout: "", stderr: "not booted" }] } });
		const res = await slimSimulator(h.exec, "U1", fast);
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("not booted");
	});

	test("slim re-enables a retired label an older denylist disabled, without reporting it", async () => {
		const h = host({ disabled: ["com.apple.gamed"] });
		const res = await slimSimulator(h.exec, "U1", fast);
		expect(h.verbs("enable")).toEqual([["enable", "system/com.apple.gamed"]]);
		expect(res.success && res.data).not.toContain("com.apple.gamed");
	});
});

describe("batch unload", () => {
	const all = [...DENYLIST];

	test("a fresh sim: every plist goes in chunks of 64, no per-label spawn, read back verified", async () => {
		const h = host({ loaded: all, plists: all });
		const res = await slimSimulatorReport(h.exec, "U1", fast);
		expect(res.success && res.data).toMatchObject({ batched: all.length, perLabel: 0, verified: true });
		const unloads = h.verbs("unload");
		expect(unloads).toHaveLength(Math.ceil(all.length / SLIM_BATCH_SIZE));
		for (const call of unloads) expect(call.length - 2).toBeLessThanOrEqual(SLIM_BATCH_SIZE);
		expect(h.verbs("disable")).toHaveLength(0);
		expect(h.verbs("bootout")).toHaveLength(0);
		// print-disabled, list, then after the batch print-disabled, list, then the read-back
		expect(h.spawned()).toHaveLength(unloads.length + 5);
	});

	test("65 plists make 2 unload spawns", async () => {
		const sixtyFive = all.slice(0, 65);
		const h = host({ plists: sixtyFive });
		await slimSimulator(h.exec, "U1", { ...fast, profile: { except: [], keep: all.slice(65) } });
		const sizes = h.verbs("unload").map((c) => c.length - 2);
		expect(sizes).toEqual([64, 1]);
	});

	test("a plist whose Label differs is never unloaded; its label goes per-label", async () => {
		const [odd, ...rest] = all as [string, ...string[]];
		const h = host({ loaded: all, plists: all, plistLabel: { [plistOf(odd)]: "com.apple.something.else" } });
		const res = await slimSimulatorReport(h.exec, "U1", fast);
		expect(res.success && res.data).toMatchObject({ batched: rest.length, perLabel: 1 });
		const unloaded = h.verbs("unload").flatMap((c) => c.slice(2));
		expect(unloaded).not.toContain(plistOf(odd));
		expect(h.verbs("disable")).toEqual([["disable", `system/${odd}`]]);
		expect(h.verbs("bootout")).toEqual([["bootout", `system/${odd}`]]);
	});

	test("a label still loaded after the batch gets disable + bootout", async () => {
		const first = all[0] as string;
		const h = host({ loaded: all, plists: all });
		const exec: Exec = async (cmd) => {
			const res = await h.exec(cmd);
			if (cmd[5] === "unload") h.loaded.add(first);
			return res;
		};
		const res = await slimSimulatorReport(exec, "U1", fast);
		expect(res.success && res.data.perLabel).toBe(1);
		expect(h.verbs("bootout")).toEqual([["bootout", `system/${first}`]]);
		expect(h.loaded.size).toBe(0);
	});

	test("without a runtime root everything goes per-label (2 spawns each at worst)", async () => {
		const h = host({ loaded: all, noRuntime: true });
		const res = await slimSimulatorReport(h.exec, "U1", fast);
		expect(res.success && res.data).toMatchObject({ batched: 0, perLabel: all.length, verified: true });
		expect(h.verbs("unload")).toHaveLength(0);
		expect(h.verbs("disable")).toHaveLength(all.length);
		expect(h.verbs("bootout")).toHaveLength(all.length);
	});
});

describe("hardening", () => {
	test("launchd 124 / 'Domain is tearing down' on a read is retried with 1 s, 2 s backoff", async () => {
		const clock = sleeps();
		const h = host({
			script: {
				"print-disabled": [
					{ exitCode: 124, stdout: "", stderr: "" },
					{ exitCode: 1, stdout: "", stderr: "Domain is tearing down" },
				],
			},
		});
		const res = await slimSimulator(h.exec, "U1", { ...clock, fileExists: () => true });
		expect(res.success).toBe(true);
		expect(clock.waited.slice(0, 2)).toEqual([1000, 2000]);
	});

	test("a read that stays 124 gives up with the error", async () => {
		const stuck = { exitCode: 124, stdout: "", stderr: "code=124" };
		const h = host({ script: { "print-disabled": [stuck, stuck, stuck, stuck] } });
		const clock = sleeps();
		const res = await slimSimulator(h.exec, "U1", { ...clock });
		expect(res.success).toBe(false);
		expect(clock.waited).toEqual([1000, 2000, 4000]);
	});

	test("a timed-out spawn is retried on the next pass", async () => {
		const clock = sleeps();
		const target = "com.apple.healthd";
		const h = host({ loaded: [target] });
		let timedOutOnce = false;
		const exec: Exec = async (cmd) => {
			if (cmd[5] === "disable" && cmd[6] === `system/${target}` && !timedOutOnce) {
				timedOutOnce = true;
				return { exitCode: 143, stdout: "", stderr: "" };
			}
			return h.exec(cmd);
		};
		const res = await slimSimulator(exec, "U1", { ...clock });
		expect(res.success).toBe(true);
		expect(timedOutOnce).toBe(true);
		expect(clock.waited).toEqual([1000]);
		expect(h.verbs("disable").filter((c) => c[1] === `system/${target}`)).toHaveLength(1);
	});

	test("bootout exit 3 (no such process) is fine", async () => {
		const label = "com.apple.healthd";
		const h = host({
			loaded: [label],
			script: { [`bootout system/${label}`]: [{ exitCode: 3, stdout: "", stderr: "No such process" }] },
		});
		const res = await slimSimulator(h.exec, "U1", fast);
		expect(res.success).toBe(true);
	});

	test("labels that never take: error counts and names them after the read-back", async () => {
		const stuck = ["com.apple.healthd", "com.apple.newsd"];
		const h = host({ stuck });
		const res = await slimSimulator(h.exec, "U1", fast);
		expect(res.success).toBe(false);
		if (!res.success)
			expect(res.error).toMatch(/2 of \d+ disable overrides did not take: .*com\.apple\.(healthd|newsd)/);
	});

	test("a persistently failing disable is retried 3 more times then reported", async () => {
		const clock = sleeps();
		const first = [...desiredLabels(DEFAULT_SLIM_PROFILE)][0] as string;
		const h = host();
		const exec: Exec = async (cmd) =>
			cmd[5] === "disable" && cmd[6] === `system/${first}` ? { exitCode: 1, stdout: "", stderr: "boom" } : h.exec(cmd);
		const res = await slimSimulator(exec, "U1", { ...clock });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("boom");
		expect(clock.waited).toEqual([1000, 2000, 4000]);
	});
});

describe("restore", () => {
	test("load -w the plists, then enable what is still disabled, then bootstrap what is not loaded", async () => {
		const a = "com.apple.healthd";
		const b = "com.apple.newsd";
		const c = "com.apple.gamed";
		const h = host({ disabled: [a, b, c], plists: [a, b, c] });
		const exec: Exec = async (cmd) => {
			const res = await h.exec(cmd);
			// the batch load leaves `b` disabled and nothing is loaded afterwards
			if (cmd[5] === "load") {
				h.disabled.add(b);
				h.loaded.clear();
			}
			return res;
		};
		const res = await slimSimulatorReport(exec, "U1", { ...fast, restore: true });
		expect(res.success && res.data.labels).toEqual([a, c, b].sort());
		const verbs = h.spawned().map((s) => s[0]);
		expect(verbs.indexOf("load")).toBeLessThan(verbs.indexOf("enable"));
		expect(verbs.indexOf("enable")).toBeLessThan(verbs.indexOf("bootstrap"));
		expect(h.verbs("load")[0]?.slice(0, 2)).toEqual(["load", "-w"]);
		expect(h.verbs("load")[0]?.slice(2).sort()).toEqual([plistOf(a), plistOf(b), plistOf(c)].sort());
		expect(h.verbs("enable")).toEqual([["enable", `system/${b}`]]);
		expect(
			h
				.verbs("bootstrap")
				.map((s) => s[2])
				.sort()
		).toEqual([plistOf(a), plistOf(b), plistOf(c)].sort());
		expect(h.disabled.size).toBe(0);
	});

	test("bootstrap exit 37 (already loaded) is fine", async () => {
		const a = "com.apple.healthd";
		const h = host({
			disabled: [a],
			plists: [a],
			script: { bootstrap: [{ exitCode: 37, stdout: "", stderr: "already loaded" }] },
		});
		const exec: Exec = async (cmd) => {
			const res = await h.exec(cmd);
			if (cmd[5] === "load") h.loaded.clear();
			return res;
		};
		const res = await slimSimulator(exec, "U1", { ...fast, restore: true });
		expect(res.success).toBe(true);
	});

	test("a dry run lists but spawns no change", async () => {
		const h = host({ disabled: ["com.apple.newsd"] });
		const res = await slimSimulator(h.exec, "U1", { ...fast, restore: true, dryRun: true });
		expect(res).toEqual({ success: true, data: ["com.apple.newsd"] });
		expect(h.spawned().map((s) => s[0])).toEqual(["print-disabled"]);
	});
});

describe("concurrency", () => {
	const all = [...DENYLIST];

	/** `host` whose per-label `disable|bootout|enable` spawns are slow enough to overlap, recording the peak in flight. */
	function gauge(options: HostOptions = {}, failOn?: string) {
		const h = host(options);
		const stats = { inFlight: 0, peak: 0, started: [] as string[] };
		const exec: Exec = async (cmd) => {
			const verb = cmd[5] ?? "";
			if (!["disable", "bootout", "enable"].includes(verb)) return h.exec(cmd);
			const key = cmd.slice(5).join(" ");
			stats.started.push(key);
			stats.inFlight++;
			stats.peak = Math.max(stats.peak, stats.inFlight);
			await Bun.sleep(2);
			stats.inFlight--;
			if (key === failOn) return { exitCode: 1, stdout: "", stderr: "boom" };
			return h.exec(cmd);
		};
		return { exec, stats, h };
	}

	test("slimming runs per-label spawns in parallel, never more than SLIM_CONCURRENCY at once", async () => {
		const { exec, stats } = gauge({ loaded: all });
		const res = await slimSimulator(exec, "U1", fast);
		expect(res.success && res.data).toEqual(all);
		expect(stats.started).toHaveLength(all.length * 2);
		expect(stats.peak).toBeGreaterThan(1);
		expect(stats.peak).toBeLessThanOrEqual(SLIM_CONCURRENCY);
	});

	test("restoring is bounded the same way and re-enables everything", async () => {
		const { exec, stats } = gauge({ disabled: all });
		const res = await slimSimulator(exec, "U1", { ...fast, restore: true });
		expect(res.success && res.data).toEqual([...all].sort());
		expect(stats.started).toHaveLength(all.length);
		expect(stats.peak).toBeGreaterThan(1);
		expect(stats.peak).toBeLessThanOrEqual(SLIM_CONCURRENCY);
	});

	test("a failing disable is the error returned once retries are spent", async () => {
		const first = all[0] as string;
		const { exec } = gauge({}, `disable system/${first}`);
		const res = await slimSimulator(exec, "U1", fast);
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("boom");
	});

	test("a fresh sim, no plists: 3 reads + N disables + L bootouts + 1 read-back", async () => {
		const loaded = all.slice(0, 10);
		const { exec, h } = gauge({ loaded, noRuntime: true });
		const res = await slimSimulator(exec, "U1", fast);
		expect(res.success && res.data).toEqual(all);
		expect(h.spawned()).toHaveLength(2 + all.length + loaded.length + 1);
		expect(
			h
				.verbs("bootout")
				.map((c) => c[1])
				.sort()
		).toEqual(loaded.map((label) => `system/${label}`).sort());
	});

	test("each job is disabled before it is booted out", async () => {
		const { exec, stats } = gauge({ loaded: all });
		await slimSimulator(exec, "U1", fast);
		for (const label of all) {
			expect(stats.started.indexOf(`disable system/${label}`)).toBeLessThan(
				stats.started.indexOf(`bootout system/${label}`)
			);
		}
	});
});
