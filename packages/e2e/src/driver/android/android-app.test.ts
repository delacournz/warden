import { describe, expect, test } from "bun:test";
import { openAdbSession } from "./adb-session";
import { createAppCommands } from "./android-app";
import { fakeAndroidHost } from "./android-host.testing";

function setup(init: Parameters<typeof fakeAndroidHost>[0] = {}) {
	const host = fakeAndroidHost(init);
	const session = openAdbSession({ adb: "adb", serial: "s1", spawn: host.spawn });
	const app = createAppCommands({ session, exec: host.exec, adb: "adb", serial: "s1" });
	return { host, session, app };
}

describe("app commands", () => {
	test("launch force-stops then monkey-launches", async () => {
		const { host, session, app } = setup({ shell: [{ match: "monkey", reply: "Events injected: 1\n" }] });
		expect((await app.launch("com.x")).success).toBe(true);
		expect(host.shell).toEqual(["am force-stop com.x", "monkey -p com.x -c android.intent.category.LAUNCHER 1"]);
		await session.close();
	});

	test("launch with relaunch:false skips the force-stop", async () => {
		const { host, session, app } = setup();
		await app.launch("com.x", { relaunch: false });
		expect(host.shell).toEqual(["monkey -p com.x -c android.intent.category.LAUNCHER 1"]);
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
