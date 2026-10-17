import { describe, expect, test } from "bun:test";
import { driverErr } from "../errors";
import { collectSpanDetail, type SpanDetail } from "../span-detail";
import { type AdbSession, openAdbSession } from "./adb-session";
import { createAppCommands, parseLauncherComponent, parseStartWait } from "./android-app";
import { fakeAndroidHost, type ShellRule } from "./android-host.testing";

const RESOLVED = "priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\ncom.x/.MainActivity\n";
const STARTED =
	"Starting: Intent { act=android.intent.action.MAIN cat=[android.intent.category.LAUNCHER] cmp=com.x/.MainActivity }\nStatus: ok\nLaunchState: COLD\nActivity: com.x/.MainActivity\nTotalTime: 812\nWaitTime: 815\nComplete\n";

const START = "am start -W";
/** the launcher's intent, so a start without -S brings a running task to the front instead of stacking an instance */
const INTENT = "-a android.intent.action.MAIN -c android.intent.category.LAUNCHER";

function setup(init: Parameters<typeof fakeAndroidHost>[0] = {}, appPackage?: string) {
	const host = fakeAndroidHost(init);
	const session = openAdbSession({ adb: "adb", serial: "s1", spawn: host.spawn });
	const app = createAppCommands({
		session,
		exec: host.exec,
		adb: "adb",
		serial: "s1",
		...(appPackage ? { appPackage } : {}),
	});
	return { host, session, app };
}

describe("parseLauncherComponent", () => {
	test("the last line of --brief is the component", () => {
		expect(parseLauncherComponent(RESOLVED)).toBe("com.x/.MainActivity");
		expect(parseLauncherComponent("com.x/com.x.Main$Alias\n\n")).toBe("com.x/com.x.Main$Alias");
	});

	test("no launcher, an unknown command or noise is undefined", () => {
		expect(parseLauncherComponent("No activity found\n")).toBeUndefined();
		expect(parseLauncherComponent("Unknown command: resolve-activity\n")).toBeUndefined();
		expect(parseLauncherComponent("")).toBeUndefined();
	});
});

describe("parseStartWait", () => {
	test("Status, LaunchState and TotalTime", () => {
		expect(parseStartWait(STARTED)).toEqual({ status: "ok", launchState: "COLD", totalTimeMs: 812 });
	});

	test("an older `am` without LaunchState, or a start that was brought to the front", () => {
		expect(parseStartWait("Status: ok\nActivity: com.x/.Main\nThisTime: 400\nTotalTime: 401\nComplete\n")).toEqual({
			status: "ok",
			totalTimeMs: 401,
		});
	});

	test("an error is reported", () => {
		const parsed = parseStartWait("Error type 3\nError: Activity class {com.x/com.x.Main} does not exist.\n");
		expect(parsed.error).toContain("does not exist");
	});
});

describe("app commands", () => {
	test("launch resolves the launcher once, then is one `am start -W -S -n` per launch", async () => {
		const { host, session, app } = setup({
			shell: [
				{ match: "cmd package resolve-activity", reply: RESOLVED },
				{ match: "am start -W", reply: STARTED },
			],
		});
		expect((await app.launch("com.x")).success).toBe(true);
		expect((await app.launch("com.x")).success).toBe(true);
		expect(host.shell).toEqual([
			"cmd package resolve-activity --brief -c android.intent.category.LAUNCHER com.x",
			`${START} -S ${INTENT} -n com.x/.MainActivity`,
			`${START} -S ${INTENT} -n com.x/.MainActivity`,
		]);
		await session.close();
	});

	test("launch puts the start's Status, LaunchState and TotalTime in the span detail", async () => {
		const { session, app } = setup({
			shell: [
				{ match: "cmd package resolve-activity", reply: RESOLVED },
				{ match: "am start -W", reply: STARTED },
			],
		});
		const notes: SpanDetail = {};
		await collectSpanDetail(notes, () => app.launch("com.x"));
		expect(notes).toMatchObject({ launch: "am-start", startStatus: "ok", launchState: "COLD", totalTimeMs: 812 });
		await session.close();
	});

	test("launch with relaunch:false starts without -S", async () => {
		const { host, session, app } = setup({
			shell: [
				{ match: "cmd package resolve-activity", reply: RESOLVED },
				{ match: "am start -W", reply: STARTED },
			],
		});
		await app.launch("com.x", { relaunch: false });
		expect(host.shell.at(-1)).toBe(`${START} ${INTENT} -n com.x/.MainActivity`);
		await session.close();
	});

	test("an `am start -W` that outlives its budget (a held first frame) counts as started: no monkey, launchState timeout", async () => {
		const { host, session } = setup({
			shell: [
				{ match: "cmd package resolve-activity", reply: RESOLVED },
				{ match: "pidof com.x", reply: "4242\n" },
			],
		});
		const run: AdbSession["run"] = (cmd, opts) =>
			cmd.startsWith(START)
				? Promise.resolve(driverErr("E_TIMEOUT", `\`${cmd}\` did not finish within ${opts?.timeoutMs}ms on s1`))
				: session.run(cmd, opts);
		const timing = createAppCommands({ session: { ...session, run }, exec: host.exec, adb: "adb", serial: "s1" });
		const notes: SpanDetail = {};
		expect((await collectSpanDetail(notes, () => timing.launch("com.x"))).success).toBe(true);
		expect(notes).toMatchObject({ launch: "am-start", launchState: "timeout" });
		expect(host.shell.some((c) => c.startsWith("monkey") || c.startsWith("am force-stop"))).toBe(false);
		// the component stays known: the next launch does not resolve it again
		await timing.launch("com.x");
		expect(host.shell.filter((c) => c.startsWith("cmd package"))).toHaveLength(1);
		await session.close();
	});

	/** the real session over the fake shell, with `am start -W` and the probe after it given 20 ms */
	function timingOut(shell: ShellRule[]) {
		const host = fakeAndroidHost({
			shell: [
				{ match: "cmd package resolve-activity", reply: RESOLVED },
				{ match: START, reply: "hang" },
				...(shell ?? []),
			],
		});
		const session = openAdbSession({ adb: "adb", serial: "s1", spawn: host.spawn });
		const app = createAppCommands({
			session,
			exec: host.exec,
			adb: "adb",
			serial: "s1",
			startWaitTimeoutMs: 20,
			startProbeTimeoutMs: 20,
		});
		return { host, session, app };
	}

	test("a timed-out `am start -W` kills the shell; the app's process is checked on a fresh one and the next command works", async () => {
		const { host, session, app } = timingOut([
			{ match: "pidof com.x", reply: "4242\n" },
			{ match: "echo next", reply: "next\n" },
		]);
		expect(host.spawns()).toBe(0);
		const notes: SpanDetail = {};
		expect((await collectSpanDetail(notes, () => app.launch("com.x"))).success).toBe(true);
		expect(notes).toMatchObject({ launch: "am-start", launchState: "timeout" });
		// the shell that held the wait was killed; the probe ran on a second one
		expect(host.spawns()).toBe(2);
		expect(host.shell.at(-1)).toBe("pidof com.x");
		const next = await session.run("echo next");
		expect(next.success && next.data.stdout).toBe("next\n");
		expect(host.spawns()).toBe(2);
		await session.close();
	});

	test("a timed-out `am start -W` whose app has no process is the timeout, not a start", async () => {
		const { host, session, app } = timingOut([{ match: "pidof com.x", reply: { stdout: "", exitCode: 1 } }]);
		const res = await app.launch("com.x");
		expect(!res.success && res.error.code).toBe("E_TIMEOUT");
		expect(host.shell.some((c) => c.startsWith("monkey"))).toBe(false);
		await session.close();
	});

	test("a timed-out `am start -W` on a shell that no longer answers (a stalled device) is the timeout, not a start", async () => {
		const { session, app } = timingOut([{ match: "pidof com.x", reply: "hang" }]);
		const res = await app.launch("com.x");
		expect(!res.success && res.error.code).toBe("E_TIMEOUT");
		await session.close();
	});

	test("a session failure other than the timeout is returned as it is (a start that answered with an error falls back, above)", async () => {
		const { host, session } = setup({ shell: [{ match: "cmd package resolve-activity", reply: RESOLVED }] });
		const run: AdbSession["run"] = (cmd, opts) =>
			cmd.startsWith(START) ? Promise.resolve(driverErr("E_IO", "adb shell exited")) : session.run(cmd, opts);
		const failing = createAppCommands({ session: { ...session, run }, exec: host.exec, adb: "adb", serial: "s1" });
		const res = await failing.launch("com.x");
		expect(!res.success && res.error.code).toBe("E_IO");
		await session.close();
	});

	test("`Status: timeout` from am's own wait is a start: no monkey, the status is noted", async () => {
		const { host, session, app } = setup({
			shell: [
				{ match: "cmd package resolve-activity", reply: RESOLVED },
				{
					match: START,
					reply:
						"Starting: Intent { cmp=com.x/.MainActivity }\nStatus: timeout\nActivity: com.x/.MainActivity\nComplete\n",
				},
			],
		});
		const notes: SpanDetail = {};
		expect((await collectSpanDetail(notes, () => app.launch("com.x"))).success).toBe(true);
		expect(notes).toMatchObject({ launch: "am-start", startStatus: "timeout" });
		expect(host.shell.some((c) => c.startsWith("monkey"))).toBe(false);
		await session.close();
	});

	test("an unresolvable launcher falls back to force-stop + monkey, and is asked again next launch", async () => {
		const { host, session, app } = setup({
			shell: [
				{ match: "cmd package resolve-activity", reply: "No activity found\n" },
				{ match: "monkey", reply: "Events injected: 1\n" },
			],
		});
		const notes: SpanDetail = {};
		expect((await collectSpanDetail(notes, () => app.launch("com.x"))).success).toBe(true);
		expect(notes.launch).toBe("monkey");
		expect(host.shell).toEqual([
			"cmd package resolve-activity --brief -c android.intent.category.LAUNCHER com.x",
			"am force-stop com.x",
			"monkey -p com.x -c android.intent.category.LAUNCHER 1",
		]);
		await app.launch("com.x");
		expect(host.shell.filter((c) => c.startsWith("cmd package"))).toHaveLength(2);
		await session.close();
	});

	test("launch with relaunch:false and no launcher skips the force-stop", async () => {
		const { host, session, app } = setup();
		await app.launch("com.x", { relaunch: false });
		expect(host.shell.at(-1)).toBe("monkey -p com.x -c android.intent.category.LAUNCHER 1");
		expect(host.shell).not.toContain("am force-stop com.x");
		await session.close();
	});

	test("a start error (the activity is gone after a reinstall) drops the cached component and falls back to monkey", async () => {
		let starts = 0;
		const { host, session, app } = setup({
			shell: [
				{ match: "cmd package resolve-activity", reply: RESOLVED },
				{
					match: "am start -W",
					reply: () =>
						starts++ === 0
							? STARTED
							: "Starting: Intent { cmp=com.x/.MainActivity }\nError type 3\nError: Activity class {com.x/com.x.MainActivity} does not exist.\n",
				},
				{ match: "monkey", reply: "Events injected: 1\n" },
			],
		});
		expect((await app.launch("com.x")).success).toBe(true);
		expect((await app.launch("com.x")).success).toBe(true);
		expect(host.shell.slice(2)).toEqual([
			`${START} -S ${INTENT} -n com.x/.MainActivity`,
			"am force-stop com.x",
			"monkey -p com.x -c android.intent.category.LAUNCHER 1",
		]);
		await app.launch("com.x");
		expect(host.shell.filter((c) => c.startsWith("cmd package"))).toHaveLength(2);
		await session.close();
	});

	test("install and uninstall forget the resolved launcher", async () => {
		const { host, session, app } = setup({
			shell: [
				{ match: "cmd package resolve-activity", reply: RESOLVED },
				{ match: "am start -W", reply: STARTED },
				{ match: "pm path", reply: "package:/data/app/x.apk\n" },
			],
			host: [
				{ match: "adb -s s1 install", reply: "Success\n" },
				{ match: "adb -s s1 uninstall", reply: "Success\n" },
			],
		});
		await app.launch("com.x");
		await app.install("/x.apk");
		await app.launch("com.x");
		await app.uninstall("com.x");
		await app.launch("com.x");
		expect(host.shell.filter((c) => c.startsWith("cmd package"))).toHaveLength(3);
		await session.close();
	});

	test("launch of an unknown package is E_APP_UNAVAILABLE", async () => {
		const { session, app } = setup({
			shell: [{ match: "monkey", reply: "** No activities found to run, monkey aborted.\n" }],
		});
		const res = await app.launch("com.nope");
		expect(!res.success && res.error.code).toBe("E_APP_UNAVAILABLE");
		await session.close();
	});

	test("launch args/env are E_UNSUPPORTED", async () => {
		const { host, session, app } = setup();
		const res = await app.launch("com.x", { args: ["--initialUrl", "x"] });
		expect(!res.success && res.error.code).toBe("E_UNSUPPORTED");
		expect((await app.launch("com.x", { env: { A: "1" } })).success).toBe(false);
		expect(host.shell).toEqual([]);
		await session.close();
	});

	test("terminate and clearData", async () => {
		const { host, session, app } = setup({ shell: [{ match: "pm clear", reply: "Success\n" }] });
		expect((await app.terminate("com.x")).success).toBe(true);
		expect((await app.clearData("com.x")).success).toBe(true);
		expect(host.shell).toEqual(["am force-stop com.x", "pm clear com.x"]);
		await session.close();
	});

	test("clearData failure", async () => {
		const { session, app } = setup({ shell: [{ match: "pm clear", reply: { stdout: "Failed\n", exitCode: 1 } }] });
		const res = await app.clearData("com.x");
		expect(!res.success && res.error.code).toBe("E_APP_UNAVAILABLE");
		await session.close();
	});

	test("openUrl quotes the url and maps resolution errors", async () => {
		const { host, session, app } = setup();
		expect((await app.openUrl("myapp://a?b=1&c=2")).success).toBe(true);
		expect(host.shell).toEqual(["am start -a android.intent.action.VIEW -d 'myapp://a?b=1&c=2'"]);
		host.shellRules.unshift({ match: "am start", reply: "Error: Activity not started, unable to resolve Intent\n" });
		const bad = await app.openUrl("nope://x");
		expect(!bad.success && bad.error.code).toBe("E_APP_UNAVAILABLE");
		await session.close();
	});

	test("openUrl with an app package targets that app only, and an unhandled url is still E_APP_UNAVAILABLE", async () => {
		const { host, session, app } = setup({}, "nz.co.x");
		expect((await app.openUrl("myapp://a?b=1&c=2")).success).toBe(true);
		expect(host.shell).toEqual(["am start -a android.intent.action.VIEW -d 'myapp://a?b=1&c=2' -p nz.co.x"]);
		host.shellRules.unshift({ match: "am start", reply: "Error: Activity not started, unable to resolve Intent\n" });
		const bad = await app.openUrl("https://elsewhere.example/x");
		expect(!bad.success && bad.error.code).toBe("E_APP_UNAVAILABLE");
		await session.close();
	});

	test("isInstalled / isRunning", async () => {
		const { session, app } = setup({
			shell: [
				{ match: "pm path com.x", reply: "package:/data/app/x/base.apk\n" },
				{ match: "pm path", reply: { stdout: "", exitCode: 1 } },
				{ match: "pidof com.x", reply: "1234\n" },
				{ match: "pidof", reply: { stdout: "", exitCode: 1 } },
			],
		});
		expect(await app.isInstalled("com.x")).toEqual({ success: true, data: true });
		expect(await app.isInstalled("com.y")).toEqual({ success: true, data: false });
		expect(await app.isRunning("com.x")).toEqual({ success: true, data: true });
		expect(await app.isRunning("com.y")).toEqual({ success: true, data: false });
		await session.close();
	});

	test("install goes through host adb, not the session", async () => {
		const { host, session, app } = setup({
			host: [{ match: "adb -s s1 install", reply: "Performing Streamed Install\nSuccess\n" }],
		});
		expect((await app.install("/tmp/app.apk")).success).toBe(true);
		expect(host.host).toEqual([["adb", "-s", "s1", "install", "-r", "/tmp/app.apk"]]);
		expect(host.shell).toEqual([]);
		host.hostRules.unshift({ match: "adb -s s1 install", reply: { exitCode: 1, stderr: "INSTALL_FAILED_OLDER_SDK" } });
		const bad = await app.install("/tmp/app.apk");
		expect(!bad.success && bad.error.code).toBe("E_IO");
		await session.close();
	});

	test("uninstall is a no-op when the package is absent", async () => {
		const { host, session, app } = setup({
			shell: [{ match: "pm path", reply: { stdout: "", exitCode: 1 } }],
		});
		expect((await app.uninstall("com.x")).success).toBe(true);
		expect(host.host).toEqual([]);
		host.shellRules.unshift({ match: "pm path", reply: "package:/x\n" });
		host.hostRules.unshift({ match: "adb -s s1 uninstall", reply: "Success\n" });
		expect((await app.uninstall("com.x")).success).toBe(true);
		expect(host.host).toEqual([["adb", "-s", "s1", "uninstall", "com.x"]]);
		await session.close();
	});
});
