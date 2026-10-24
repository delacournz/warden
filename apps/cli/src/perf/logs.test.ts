import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LogStream } from "@delacour/warden-perf/logs/pid-follow";
import { createPerfCommand } from "../commands/perf";
import { fakeExec, type TestContext, testContext } from "../testing";
import { defaultLogDeps, type LogDeps, perfLogs, registerLogs, runLogCapture } from "./logs";
import { asMe, fakePerfDeps } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const read = (name: string) =>
	readFileSync(new URL(`../../../../packages/perf/fixtures/${name}`, import.meta.url), "utf8");
const ANDROID = read("logcat-app-threadtime.txt");
const IOS = read("log-stream-compact.txt");
const APP = "/sim/Containers/Bundle/Application/AB/ShopApp.app";
const EMU = "emulator-5554";

type Handlers = Array<[string, { stdout: string; exitCode?: number }]>;

function setup(platform: "ios" | "android", handlers: Handlers) {
	const calls: string[][] = [];
	const id = platform === "ios" ? "U1" : EMU;
	const c = testContext([], { exec: fakeExec(handlers, calls) });
	ctx = c;
	asMe(c);
	c.db.recordDevice({ platform, id, name: "dev" }, 1);
	return { c, calls, deps: fakePerfDeps([{ platform, id, name: "dev" }]) };
}

const androidHandlers = (extra: Handlers = []): Handlers => [
	[`adb -s ${EMU} shell pidof com.acme.shop`, { stdout: "4321\n" }],
	[`adb -s ${EMU} shell date`, { stdout: "2026-10-24 10:00:05\n" }],
	[`adb -s ${EMU} logcat -d`, { stdout: ANDROID }],
	...extra,
];

const iosHandlers = (): Handlers => [
	["xcrun simctl get_app_container U1 com.acme.shop app", { stdout: `${APP}\n` }],
	["plutil -extract CFBundleExecutable", { stdout: "ShopApp\n" }],
	["xcrun simctl spawn U1 log show", { stdout: IOS }],
];

describe("perf logs one-shot", () => {
	test("android: pid-bound logcat, redacted, json envelope", async () => {
		const { c, calls, deps } = setup("android", androidHandlers());
		expect(await perfLogs(c, deps, { json: true, app: "com.acme.shop" })).toBe(0);
		const logcat = calls.find((a) => a.includes("logcat"));
		expect(logcat).toEqual(["adb", "-s", EMU, "logcat", "-d", "-v", "threadtime", "--pid", "4321", "-t", "200"]);
		const doc = JSON.parse(c.stdout.join("\n"));
		expect(doc).toMatchObject({ ok: true, command: "perf logs", result: { app: "com.acme.shop", count: 7 } });
		const all = JSON.stringify(doc);
		expect(all).not.toContain("sk_live_51Hxyz");
		expect(all).not.toContain("eyJhbGci");
		expect(all).toContain("api_key=[redacted]");
	});

	test("android: --level and --grep filter, text output", async () => {
		const { c, calls, deps } = setup("android", androidHandlers());
		expect(await perfLogs(c, deps, { app: "com.acme.shop", level: "E", grep: "typeerror" })).toBe(0);
		expect(c.stdout.join("\n").split("\n")).toEqual([
			"10-24 10:00:02.310  4321 E ReactNativeJS: [TypeError: undefined is not an object (evaluating 'cart.items.length')]",
		]);
		expect(calls.find((a) => a.includes("logcat"))).toContain("10000");
	});

	test("android: --since is relative to the device clock", async () => {
		const { c, deps } = setup("android", androidHandlers());
		await perfLogs(c, deps, { json: true, app: "com.acme.shop", since: "2s" });
		const entries = JSON.parse(c.stdout.join("\n")).result.entries;
		expect(entries.map((e: { ts: string }) => e.ts)).toEqual(["10-24 10:00:03.000"]);
	});

	test("android: --lines keeps the newest", async () => {
		const { c, deps } = setup("android", androidHandlers());
		await perfLogs(c, deps, { json: true, app: "com.acme.shop", lines: "2" });
		const doc = JSON.parse(c.stdout.join("\n"));
		expect(doc.result).toMatchObject({ count: 2, truncated: true });
		expect(doc.warnings?.[0]).toContain("--lines");
	});

	test("android: app not running", async () => {
		const { c, deps } = setup("android", [[`adb -s ${EMU} shell pidof`, { stdout: "", exitCode: 1 }]]);
		expect(await perfLogs(c, deps, { json: true, app: "com.acme.shop" })).toBe(1);
		expect(JSON.parse(c.stdout.join("\n")).error.code).toBe("app_not_found");
	});

	test("ios: log show with the app predicate", async () => {
		const { c, calls, deps } = setup("ios", iosHandlers());
		expect(await perfLogs(c, deps, { json: true, app: "com.acme.shop", since: "10m" })).toBe(0);
		const show = calls.find((a) => a.includes("show"));
		expect(show).toEqual([
			"xcrun",
			"simctl",
			"spawn",
			"U1",
			"log",
			"show",
			"--style",
			"compact",
			"--info",
			"--last",
			"600s",
			"--predicate",
			'subsystem == "com.acme.shop" OR subsystem BEGINSWITH "com.acme.shop" OR process == "ShopApp"',
		]);
		const doc = JSON.parse(c.stdout.join("\n"));
		expect(doc.result.count).toBe(6);
		expect(JSON.stringify(doc)).not.toContain("delacour.co.nz");
		expect(JSON.stringify(doc)).not.toContain("sk_live");
	});

	test("ios: --level W keeps errors and faults", async () => {
		const { c, deps } = setup("ios", iosHandlers());
		await perfLogs(c, deps, { json: true, app: "com.acme.shop", level: "warn" });
		const levels = JSON.parse(c.stdout.join("\n")).result.entries.map((e: { level: string }) => e.level);
		expect(levels).toEqual(["E", "F"]);
	});

	test("bad flags are usage errors", async () => {
		const { c, deps } = setup("android", androidHandlers());
		expect(await perfLogs(c, deps, { json: true, app: "x", level: "loud" })).toBe(1);
		expect(JSON.parse(c.stdout.join("\n")).error.code).toBe("usage");
		c.stdout.length = 0;
		expect(await perfLogs(c, deps, { json: true, app: "x", grep: "(" })).toBe(1);
		expect(JSON.parse(c.stdout.join("\n")).error.message).toContain("--grep");
	});
});

/** Fake spawn: emits `lines` once, then stays alive until killed. */
function fakeLogDeps(lines: string[], opts: { abortAfterSleeps?: number; abortOnSpawn?: boolean } = {}) {
	const controller = new AbortController();
	const spawned: string[][] = [];
	let sleeps = 0;
	const deps: LogDeps = {
		spawn: (argv, onLine) => {
			spawned.push(argv);
			for (const l of lines) onLine(l);
			if (opts.abortOnSpawn) controller.abort();
			let end: (n: number) => void = () => {};
			const exited = new Promise<number>((resolve) => {
				end = resolve;
			});
			const stream: LogStream = { kill: () => end(0), exited };
			return stream;
		},
		sleep: async () => {
			sleeps++;
			if (sleeps >= (opts.abortAfterSleeps ?? 1)) controller.abort();
		},
		interrupt: () => ({ signal: controller.signal, dispose: () => {} }),
	};
	return { deps, spawned, controller };
}

describe("perf logs --follow", () => {
	test("android: NDJSON, redacted, filtered, exit 130 on interrupt", async () => {
		const { c, deps } = setup("android", androidHandlers());
		const { deps: logDeps, spawned } = fakeLogDeps(ANDROID.split("\n"));
		const code = await perfLogs(c, deps, { json: true, follow: true, app: "com.acme.shop", level: "W" }, logDeps);
		expect(code).toBe(130);
		expect(spawned[0]).toEqual(["adb", "-s", EMU, "logcat", "-v", "threadtime", "--pid", "4321"]);
		const rows = c.stdout.map((l) => JSON.parse(l));
		expect(rows.map((r) => r.level)).toEqual(["W", "E", "E"]);
		expect(c.stdout.join("")).not.toContain("sk_live");
	});

	test("ios: log stream with predicate, text lines", async () => {
		const { c, deps } = setup("ios", iosHandlers());
		const { deps: logDeps, spawned } = fakeLogDeps(IOS.split("\n"), { abortOnSpawn: true });
		const code = await perfLogs(c, deps, { follow: true, app: "com.acme.shop", grep: "login" }, logDeps);
		expect(code).toBe(130);
		expect(spawned[0]?.slice(0, 8)).toEqual(["xcrun", "simctl", "spawn", "U1", "log", "stream", "--style", "compact"]);
		expect(c.stdout).toEqual([
			"2026-10-24 10:00:02.004  4321 E com.facebook.react.log:javascript: login failed for [redacted]",
		]);
	});

	test("a stream that ends on its own is a failure", async () => {
		const { c, deps } = setup("ios", iosHandlers());
		const logDeps: LogDeps = { ...fakeLogDeps([]).deps, spawn: () => ({ kill: () => {}, exited: Promise.resolve(3) }) };
		expect(await perfLogs(c, deps, { json: true, follow: true, app: "com.acme.shop" }, logDeps)).toBe(1);
		expect(JSON.parse(c.stdout.join("\n")).error.message).toContain("ended");
	});
});

describe("runLogCapture", () => {
	test("appends redacted raw lines to the out file until aborted", async () => {
		const { c } = setup("android", androidHandlers());
		const { deps, controller } = fakeLogDeps(ANDROID.split("\n").filter(Boolean));
		const out = join(c.cwd, "logs", "device.log");
		const done = await runLogCapture(
			c,
			{ udid: EMU, platform: "android" },
			{ id: "com.acme.shop" },
			out,
			controller.signal,
			deps
		);
		expect(done).toEqual({ success: true, data: { lines: 8 } });
		expect(existsSync(out)).toBe(true);
		const text = readFileSync(out, "utf8");
		expect(text).toContain('Running "main"');
		expect(text).not.toContain("sk_live");
		expect(text).toContain("Authorization: [redacted]");
	});
});

test("default deps spawn survives a missing binary", async () => {
	const stream = defaultLogDeps.spawn(["/nonexistent/warden-test-bin"], () => {});
	expect(await stream.exited).toBe(127);
});

test("logs is wired onto warden perf with its flags", async () => {
	const { deps } = setup("android", androidHandlers());
	const c = testContext(["logs", "--json", "--app", "com.acme.shop", "--lines", "0", "-f"], { exec: fakeExec([]) });
	ctx?.cleanup();
	ctx = c;
	c.db.recordDevice({ platform: "android", id: EMU, name: "dev" }, 1);
	expect(await createPerfCommand(deps, [registerLogs]).run(c)).toBe(1);
	expect(JSON.parse(c.stdout.join("\n")).error.code).toBe("usage");
});
