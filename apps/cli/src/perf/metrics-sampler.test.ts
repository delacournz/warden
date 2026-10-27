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

const launchctl = (pid: number | "-") => `PID\tStatus\tLabel\n${pid}\t0\tUIKitApplication:${APP}[0x1a2b][rb-legacy]\n`;

const iosScript =
	(ps: () => string, pid: () => number | "-" = () => 845): Script =>
	(cmd) => {
		if (cmd.includes("get_app_container")) return { stdout: `${EXE.slice(0, EXE.lastIndexOf("/"))}\n` };
		if (cmd.startsWith("plutil")) return { stdout: "Example\n" };
		if (cmd.includes("simctl spawn U1 launchctl list")) return { stdout: launchctl(pid()) };
		if (cmd.startsWith("ps -o")) return { stdout: ps() };
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
		const { c } = setup(
			iosScript(
				() => "  PID  PPID    RSS  %CPU      TIME STARTED                      COMMAND\n",
				() => "-"
			)
		);
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

	test("only reads: get_app_container, plutil, launchctl list and pid-scoped host ps (the sim runtime has no ps)", async () => {
		const { c, calls } = setup(iosScript(() => fx("ps-timed-app.txt")));
		const s = await createSampler(c, { udid: "U1", platform: "ios", app: APP }, 0);
		if (s.success) await s.data.sample();
		expect(
			calls.every((cmd) =>
				/get_app_container|plutil|simctl spawn U1 launchctl list|^ps -o pid,ppid,rss,%cpu,time,lstart,command -p 845$/.test(
					cmd
				)
			)
		).toBe(true);
		expect(calls.some((cmd) => cmd.includes("simctl spawn U1 ps"))).toBe(false);
	});

	test("a system app shared by every sim of a runtime: the row of this sim's pid, not another sim's", async () => {
		const shared =
			"/Library/Developer/CoreSimulator/Volumes/iOS_23F77/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 26.5.simruntime/Contents/Resources/RuntimeRoot/Applications/Preferences.app";
		const rows = [
			"  PID  PPID    RSS  %CPU      TIME STARTED                      COMMAND",
			`  700     1  90000   1.0   0:03.00 Sat Oct 24 09:00:01 2026     ${shared}/Preferences`,
			`  845     1  50000   1.0   0:02.00 Sat Oct 24 09:10:01 2026     ${shared}/Preferences`,
		].join("\n");
		const { c } = setup((cmd) => {
			if (cmd.includes("get_app_container")) return { stdout: `${shared}\n` };
			if (cmd.startsWith("plutil")) return { stdout: "Preferences\n" };
			if (cmd.includes("simctl spawn U1 launchctl list")) return { stdout: launchctl(845) };
			if (cmd.startsWith("ps -o")) return { stdout: rows };
			return undefined;
		});
		const s = await createSampler(c, { udid: "U1", platform: "ios", app: APP }, 0);
		if (!s.success) throw new Error(s.error.message);
		const r = await s.data.sample();
		expect(r.success && r.data).toMatchObject({ pid: 845, rssKb: 50000 });
	});

	test("pid resolved once across N samples; ps is pid-scoped", async () => {
		const { c, clock, calls } = setup(iosScript(() => fx("ps-timed-app.txt")));
		const s = await createSampler(c, { udid: "U1", platform: "ios", app: APP }, 0);
		if (!s.success) throw new Error("create");
		for (let i = 0; i < 5; i++) {
			clock.now += 1000;
			await s.data.sample();
		}
		expect(calls.filter((cmd) => cmd.includes("launchctl list"))).toHaveLength(1);
		const ps = calls.filter((cmd) => cmd.startsWith("ps "));
		expect(ps).toHaveLength(5);
		expect(ps.every((cmd) => cmd.endsWith("-p 845") && !cmd.includes("-ax"))).toBe(true);
	});

	test("re-resolved when ps has no row for the cached pid", async () => {
		let pid = 845;
		const { c, calls } = setup(
			iosScript(
				() => fx("ps-timed-app.txt").replace(/^ {2}845 /m, `  ${pid} `),
				() => pid
			)
		);
		const s = await createSampler(c, { udid: "U1", platform: "ios", app: APP }, 0);
		if (!s.success) throw new Error("create");
		await s.data.sample();
		pid = 999;
		const r = await s.data.sample();
		expect(r.success && r.data.pid).toBe(999);
		expect(calls.filter((cmd) => cmd.includes("launchctl list"))).toHaveLength(2);
		expect(calls.at(-1)).toEndWith("-p 999");
	});

	test("re-resolved when lstart changes (pid reuse), charging the new process's CPU", async () => {
		let started = "Sat Oct 24 09:14:55 2026";
		const ps = () => psWith("0:05.00", 300000).replace("Sat Oct 24 09:14:55 2026", started);
		const { c, clock, calls } = setup(iosScript(ps));
		const s = await createSampler(c, { udid: "U1", platform: "ios", app: APP }, 0);
		if (!s.success) throw new Error("create");
		await s.data.sample();
		started = "Sat Oct 24 09:30:00 2026";
		clock.now += 1000;
		const r = await s.data.sample();
		expect(r.success).toBe(true);
		expect(calls.filter((cmd) => cmd.includes("launchctl list"))).toHaveLength(2);
		expect(calls.filter((cmd) => cmd.startsWith("ps "))).toHaveLength(3);
	});

	test("first sample has no cpuPct, second has the delta", async () => {
		let cpu = "1:00.00";
		const { c, clock } = setup(iosScript(() => psWith(cpu, 300000)));
		const s = await createSampler(c, { udid: "U1", platform: "ios", app: APP }, 0);
		if (!s.success) throw new Error("create");
		const first = await s.data.sample();
		expect(first.success && first.data.cpuPct).toBeUndefined();
		clock.now += 1000;
		cpu = "1:00.30";
		const second = await s.data.sample();
		expect(second.success && second.data.cpuPct).toBe(30);
	});

	test("app gone: ps no row and launchctl has no pid -> app_not_found", async () => {
		let alive = true;
		const { c } = setup(
			iosScript(
				() =>
					alive ? fx("ps-timed-app.txt") : "  PID  PPID    RSS  %CPU      TIME STARTED                      COMMAND\n",
				() => (alive ? 845 : "-")
			)
		);
		const s = await createSampler(c, { udid: "U1", platform: "ios", app: APP }, 0);
		if (!s.success) throw new Error("create");
		await s.data.sample();
		alive = false;
		expect(await s.data.sample()).toMatchObject({ success: false, error: { code: "app_not_found" } });
	});

	test("app relaunched: the new pid is picked up", async () => {
		let pid = 845;
		const { c } = setup(
			iosScript(
				() => fx("ps-timed-app.txt").replace(/^ {2}845 /m, `  ${pid} `),
				() => pid
			)
		);
		const s = await createSampler(c, { udid: "U1", platform: "ios", app: APP }, 0);
		if (!s.success) throw new Error("create");
		await s.data.sample();
		pid = 999;
		const r = await s.data.sample();
		expect(r.success && r.data.pid).toBe(999);
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
