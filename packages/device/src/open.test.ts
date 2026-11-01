import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProxy } from "@delacour/warden-driver/testing/network-proxy";
import { MemoryAndroidState } from "@delacour/warden-driver-android/android-state";
import { FakeAndroidHost } from "@delacour/warden-driver-android/testing/android-host";
import { fakeExec } from "@delacour/warden-driver-ios/testing/exec";
import { fakeSimd } from "@delacour/warden-driver-ios/testing/simd";
import { androidOptions, openDriver } from "./open";

const PHONE = "00008140-000A0B0C0D0E0F10";

const base = (platform: "ios" | "android") => ({ platform, id: "UDID-1", appId: "nz.co.x" }) as const;

describe("openDriver", () => {
	test("ios opens the iOS driver on the id, using simdPath as the helper", async () => {
		const helper = fakeSimd.build(() => ({ data: null }));
		const result = await openDriver({
			...base("ios"),
			host: { exec: fakeExec.build([["xcrun", {}]]) },
			ios: { simdPath: "/x/warden-simd", spawn: helper.spawn, exists: (path) => path === "/x/warden-simd" },
		});
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.platform).toBe("ios");
		expect(result.data.id).toBe("UDID-1");
		expect(helper.spawns[0]?.slice(0, 3)).toEqual(["/x/warden-simd", "--udid", "UDID-1"]);
		await result.data.close();
	});

	test("debug turns the latency log on", async () => {
		const helper = fakeSimd.build(() => ({ data: null }));
		const logs: string[] = [];
		const result = await openDriver({
			...base("ios"),
			debug: true,
			log: (line) => logs.push(line),
			host: { exec: fakeExec.build([["xcrun", {}]]) },
			ios: { spawn: helper.spawn, helperPath: "/x/warden-simd", exists: () => false },
		});
		if (!result.success) throw new Error(result.error.message);
		await result.data.tap({ x: 1, y: 1 });
		await result.data.close();
		expect(logs.some((line) => /^\[ios\] op tap \d+ ms$/.test(line))).toBe(true);
	});

	test("android opens the adb driver with the env serial and the injected host seams", async () => {
		const host = new FakeAndroidHost({
			shell: [
				{ match: "getprop sys.boot_completed", reply: "1\n" },
				{ match: "wm size", reply: "Physical size: 1080x2400\n" },
				{ match: "wm density", reply: "Physical density: 420\n" },
			],
		});
		const result = await openDriver({
			...base("android"),
			host: { exec: host.exec },
			android: {
				adb: "/sdk/platform-tools/adb",
				spawn: host.spawn,
				execBinary: host.execBinary,
				state: new MemoryAndroidState(),
			},
		});
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.platform).toBe("android");
		expect(host.spawns()).toBe(1);
		await result.data.close();
	});

	test("android deep links target the app under test (appId)", async () => {
		const host = new FakeAndroidHost({
			shell: [
				{ match: "getprop sys.boot_completed", reply: "1\n" },
				{ match: "wm size", reply: "Physical size: 1080x2400\n" },
				{ match: "wm density", reply: "Physical density: 420\n" },
			],
		});
		const result = await openDriver({
			...base("android"),
			host: { exec: host.exec },
			android: { adb: "adb", spawn: host.spawn, execBinary: host.execBinary, state: new MemoryAndroidState() },
		});
		if (!result.success) throw new Error(result.error.message);
		await result.data.app.openUrl("myapp://x");
		expect(host.shell).toContain("am start -a android.intent.action.VIEW -d myapp://x -p nz.co.x");
		await result.data.close();
	});

	test("android keeps its per-serial state under <wardenHome>/android", async () => {
		const home = mkdtempSync(join(tmpdir(), "wdn-open-home-"));
		const host = new FakeAndroidHost({
			shell: [
				{ match: "getprop sys.boot_completed", reply: "1\n34\n" },
				{ match: "wm size", reply: "Physical size: 1080x2400\n" },
				{ match: "wm density", reply: "Physical density: 420\n" },
				{ match: "uiautomator dump /dev/stdout", reply: "UI hierchary dumped to: /dev/stdout\n" },
			],
			host: [
				{
					match: /exec-out uiautomator dump \/dev\/tty$/,
					reply: '<?xml version="1.0"?><hierarchy rotation="0"><node class="x" bounds="[0,0][1,1]" /></hierarchy>',
				},
			],
		});
		const result = await openDriver({
			...base("android"),
			host: { exec: host.exec, home },
			android: { adb: "adb", spawn: host.spawn, execBinary: host.execBinary },
		});
		if (!result.success) throw new Error(result.error.message);
		await result.data.snapshot();
		await result.data.close();
		expect(JSON.parse(readFileSync(join(home, "android", "UDID-1.json"), "utf8"))).toEqual({
			sdk: 34,
			dumpRoute: "tty",
		});
	});

	test("a missing helper is E_HELPER_MISSING", async () => {
		const result = await openDriver({
			...base("ios"),
			host: { exec: fakeExec.build([["xcrun", {}]]), home: "/nowhere/.warden" },
			ios: { exists: () => false, execPath: "/nowhere/warden", importDir: "/nowhere/packages/driver-ios/src" },
		});
		expect(!result.success && result.error.code).toBe("E_HELPER_MISSING");
	});

	test("an explicit simdPath that points at nothing is an error, not a fall-through", async () => {
		const result = await openDriver({
			...base("ios"),
			host: { exec: fakeExec.build([["xcrun", {}]]) },
			ios: { simdPath: "/stale/warden-simd", exists: (path) => path !== "/stale/warden-simd" },
		});
		expect(!result.success && result.error.code).toBe("E_HELPER_MISSING");
		expect(!result.success && result.error.message).toContain("WARDEN_SIMD=/stale/warden-simd does not exist");
	});

	test("reads no environment: WARDEN_SIMD in process.env is ignored", async () => {
		const previous = process.env.WARDEN_SIMD;
		process.env.WARDEN_SIMD = "/from-process-env/warden-simd";
		try {
			const result = await openDriver({
				...base("ios"),
				host: { exec: fakeExec.build([["xcrun", {}]]) },
				ios: { exists: () => false, execPath: "/nowhere/warden", importDir: "/nowhere/x/y/z" },
			});
			expect(!result.success && result.error.message).not.toContain("from-process-env");
		} finally {
			if (previous === undefined) delete process.env.WARDEN_SIMD;
			else process.env.WARDEN_SIMD = previous;
		}
	});
});

describe("androidOptions and the resident server", () => {
	test("is on by default", () => {
		expect(androidOptions({ ...base("android"), android: { state: new MemoryAndroidState() } }, false).uiad).toBe(true);
	});

	test("an injected shell is a test: the server, which spawns its own adb, stays off", () => {
		const host = new FakeAndroidHost();
		const options = androidOptions(
			{ ...base("android"), android: { spawn: host.spawn, state: new MemoryAndroidState() } },
			false
		);
		expect(options.uiad).toBeUndefined();
	});

	test("a caller's own choice wins", () => {
		const options = androidOptions(
			{ ...base("android"), android: { uiad: false, state: new MemoryAndroidState() } },
			false
		);
		expect(options.uiad).toBe(false);
	});

	test("no home, no saved state", () => {
		expect(androidOptions(base("android"), false).state).toBeUndefined();
	});
});

describe("a physical iPhone", () => {
	test("opens the device driver, not warden-simd: without a runner socket it says so", async () => {
		const helper = fakeSimd.build(() => ({ data: null }));
		const result = await openDriver({
			platform: "ios",
			id: PHONE,
			host: { exec: fakeExec.build([]) },
			ios: { spawn: helper.spawn, helperPath: "/x/warden-simd" },
		});
		expect(!result.success && result.error.code).toBe("E_HELPER_MISSING");
		expect(!result.success && result.error.message).toContain("WARDEN_IOS_RUNNER_SOCKET");
		expect(helper.spawns).toEqual([]);
	});

	test("connects to the runner socket it is given", async () => {
		const result = await openDriver({
			platform: "ios",
			id: PHONE,
			host: { exec: fakeExec.build([]) },
			iosDevice: { runnerSocket: "/nonexistent/r.sock", defaultTimeoutMs: 100 },
		});
		expect(result.success).toBe(false);
		expect(!result.success && result.error.message).not.toContain("WARDEN_IOS_RUNNER_SOCKET is not set");
	});
});

describe("the lease's shaping proxy and clock recorder", () => {
	test("none unless given: network stays unsupported, as under a bare bun test", () => {
		expect(androidOptions({ ...base("android") }, false).networkProxy).toBeUndefined();
		expect(androidOptions({ ...base("android") }, false).clockRecorder).toBeUndefined();
	});

	test("android gets the given proxy and recorder; a proxy in android wins", () => {
		const given = new FakeProxy();
		const own = new FakeProxy();
		const clockRecorder = () => {};
		const options = androidOptions({ ...base("android"), networkProxy: given, clockRecorder }, false);
		expect(options.networkProxy).toBe(given);
		expect(options.clockRecorder).toBe(clockRecorder);
		expect(
			androidOptions({ ...base("android"), networkProxy: given, android: { networkProxy: own } }, false).networkProxy
		).toBe(own);
	});
});
