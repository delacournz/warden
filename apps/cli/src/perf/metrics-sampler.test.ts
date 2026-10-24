import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecResult } from "@delacour/warden-core/exec";
import { type TestContext, testContext } from "../testing";
import { createSampler } from "./metrics-sampler";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const fx = (name: string) =>
	readFileSync(join(import.meta.dir, "..", "..", "..", "..", "packages", "perf", "fixtures", name), "utf8");
const APP = "nz.co.delacour.warden.example";
const EXE =
	"/Users/chris/Library/Developer/CoreSimulator/Devices/U1/data/Containers/Bundle/Application/AAAA-1111/Example.app/Example";

type Script = (cmd: string) => Partial<ExecResult> | undefined;

function setup(script: Script) {
	const clock = { now: 10_000 };
	const calls: string[] = [];
	const c = testContext([], {
		now: () => clock.now,
		exec: async (cmd) => {
			const joined = cmd.join(" ");
			calls.push(joined);
			const hit = script(joined);
			return hit === undefined
				? { exitCode: 127, stdout: "", stderr: `no handler: ${joined}` }
				: { exitCode: 0, stdout: "", stderr: "", ...hit };
		},
	});
	ctx = c;
	return { c, clock, calls };
}

/** `ps` output where the app (pid 845) has used `cpuTime` and holds `rssKb`. */
const psWith = (cpuTime: string, rssKb: number): string =>
	fx("ps-timed-app.txt").replace("312400  12.4   1:12.34", `${rssKb}  12.4 ${cpuTime.padStart(9)}`);

const iosScript =
	(ps: () => string): Script =>
	(cmd) => {
		if (cmd.includes("get_app_container")) return { stdout: `${EXE.slice(0, EXE.lastIndexOf("/"))}\n` };
		if (cmd.startsWith("plutil")) return { stdout: "Example\n" };
		if (cmd.includes("simctl spawn U1 ps")) return { stdout: ps() };
		return undefined;
	};

describe("iOS sampler", () => {
	test("first reading is the baseline: rss, no cpu", async () => {
		const { c } = setup(iosScript(() => fx("ps-timed-app.txt")));
		const s = await createSampler(c, { udid: "U1", platform: "ios", app: APP }, 10_000);
		if (!s.success) throw new Error(s.error.message);
		const first = await s.data.sample();
		expect(first).toEqual({ success: true, data: { wallMs: 10_000, atMs: 0, pid: 845, rssKb: 312400 } });
	});

	test("cpu % is the cputime delta over wall time, not ps %cpu", async () => {
		let cpu = "1:12.34";
		let rss = 312400;
		const { c, clock } = setup(iosScript(() => psWith(cpu, rss)));
		const s = await createSampler(c, { udid: "U1", platform: "ios", app: APP }, 10_000);
		if (!s.success) throw new Error(s.error.message);
		await s.data.sample();
		clock.now += 2000;
		cpu = "1:12.84";
		rss = 320000;
		const second = await s.data.sample();
		expect(second).toEqual({
			success: true,
			data: { wallMs: 12_000, atMs: 2000, pid: 845, rssKb: 320000, cpuPct: 25 },
		});
	});

	test("matches the app's own executable, not a same-named process elsewhere or an extension", async () => {
		const { c } = setup(iosScript(() => fx("ps-timed-app.txt")));
		const s = await createSampler(c, { udid: "U1", platform: "ios", app: APP }, 0);
		if (!s.success) throw new Error("create");
		const r = await s.data.sample();
		expect(r.success && r.data.pid).toBe(845);
	});

	test("app not running: app_not_found", async () => {
		const { c } = setup(iosScript(() => "  PID  PPID    RSS  %CPU      TIME STARTED                      COMMAND\n"));
		const s = await createSampler(c, { udid: "U1", platform: "ios", app: APP }, 0);
		if (!s.success) throw new Error("create");
		const r = await s.data.sample();
		expect(r).toMatchObject({ success: false, error: { code: "app_not_found" } });
	});

	test("app not installed: app_not_found from the bundle lookup", async () => {
		const { c } = setup(() => ({ exitCode: 1, stderr: "No such file" }));
		const s = await createSampler(c, { udid: "U1", platform: "ios", app: APP }, 0);
		expect(s).toMatchObject({ success: false, error: { code: "app_not_found" } });
	});

	test("only reads: nothing but get_app_container, plutil and simctl spawn ps runs", async () => {
		const { c, calls } = setup(iosScript(() => fx("ps-timed-app.txt")));
		const s = await createSampler(c, { udid: "U1", platform: "ios", app: APP }, 0);
		if (s.success) await s.data.sample();
		expect(calls.every((cmd) => /get_app_container|plutil|simctl spawn U1 ps/.test(cmd))).toBe(true);
	});
});

const androidScript =
	(opts: { pids?: () => string; top?: () => string; meminfo?: () => string }): Script =>
	(cmd) => {
		if (cmd.includes("pidof")) return { stdout: opts.pids?.() ?? "4321\n" };
		if (cmd.includes("shell top")) return { stdout: opts.top?.() ?? fx("adb-top.txt") };
		if (cmd.includes("dumpsys meminfo")) return { stdout: opts.meminfo?.() ?? fx("dumpsys-meminfo.txt") };
		return undefined;
	};

describe("Android sampler", () => {
	test("cpu from top, PSS/RSS from dumpsys meminfo", async () => {
		const { c, calls } = setup(androidScript({}));
		const s = await createSampler(c, { udid: "emulator-5554", platform: "android", app: APP }, 10_000);
		if (!s.success) throw new Error("create");
		const r = await s.data.sample();
		expect(r).toEqual({
			success: true,
			data: { wallMs: 10_000, atMs: 0, pid: 4321, cpuPct: 25, rssKb: 322432, pssKb: 228119 },
		});
		expect(calls.some((cmd) => cmd.endsWith("shell top -n 1 -b -p 4321"))).toBe(true);
		expect(calls.some((cmd) => cmd.endsWith(`shell dumpsys meminfo ${APP}`))).toBe(true);
	});

	test("meminfo unavailable: RES from top, no pss", async () => {
		const { c } = setup(androidScript({ meminfo: () => fx("dumpsys-meminfo-none.txt") }));
		const s = await createSampler(c, { udid: "emulator-5554", platform: "android", app: APP }, 0);
		if (!s.success) throw new Error("create");
		const r = await s.data.sample();
		expect(r).toMatchObject({ success: true, data: { rssKb: 256000, cpuPct: 25 } });
		expect(r.success && r.data.pssKb).toBeUndefined();
	});

	test("the app restarted: pid is re-resolved once", async () => {
		let pid = "999\n";
		const top = () => (pid.startsWith("4321") ? fx("adb-top.txt") : "");
		const { c } = setup(androidScript({ pids: () => pid, top }));
		const s = await createSampler(c, { udid: "emulator-5554", platform: "android", app: APP }, 0);
		if (!s.success) throw new Error("create");
		pid = "4321\n";
		const r = await s.data.sample();
		expect(r).toMatchObject({ success: true, data: { pid: 4321 } });
	});

	test("not running: app_not_found", async () => {
		const { c } = setup(androidScript({ pids: () => "", top: () => "" }));
		const s = await createSampler(c, { udid: "emulator-5554", platform: "android", app: APP }, 0);
		if (!s.success) throw new Error("create");
		expect(await s.data.sample()).toMatchObject({ success: false, error: { code: "app_not_found" } });
	});
});
