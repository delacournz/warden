import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExecCall, fakeExec, joined } from "../exec.testing";
import { createDevicectl, installArgv, orientationArgv, screenshotArgv, uninstallArgv } from "./devicectl";

const UDID = "00008140-000A0B0C0D0E0F10";

/** Writes `json` to the `--json-output` path the command was given, like devicectl. */
function writesJson(json: unknown) {
	return (call: ExecCall) => {
		const at = call.cmd.indexOf("--json-output");
		const path = call.cmd[at + 1];
		if (path !== undefined) writeFileSync(path, JSON.stringify(json));
		return {};
	};
}

const tools = (handlers: Parameters<typeof fakeExec>[0]) => {
	const calls: ExecCall[] = [];
	const devicectl = createDevicectl({
		udid: UDID,
		exec: fakeExec(handlers, calls),
		makeDir: async () => mkdtempSync(join(tmpdir(), "devicectl-test-")),
		remove: async () => undefined,
	});
	return { devicectl, calls };
};

describe("argv", () => {
	test("install, uninstall, orientation and screenshot name the device after the subcommand", () => {
		expect(installArgv(UDID, "/b/App.app", "/o.json")).toEqual([
			"xcrun",
			"devicectl",
			"device",
			"install",
			"app",
			"--device",
			UDID,
			"/b/App.app",
			"--json-output",
			"/o.json",
		]);
		expect(uninstallArgv(UDID, "com.x", "/o.json").slice(0, 7)).toEqual([
			"xcrun",
			"devicectl",
			"device",
			"uninstall",
			"app",
			"--device",
			UDID,
		]);
		expect(orientationArgv(UDID, "landscapeLeft")).toEqual([
			"xcrun",
			"devicectl",
			"device",
			"orientation",
			"set",
			"--device",
			UDID,
			"landscapeLeft",
		]);
		expect(screenshotArgv(UDID, "/s.png")).toEqual([
			"xcrun",
			"devicectl",
			"device",
			"capture",
			"screenshot",
			"--device",
			UDID,
			"--destination",
			"/s.png",
		]);
	});
});

describe("devicectl", () => {
	test("install answers the bundle ids it installed", async () => {
		const { devicectl, calls } = tools([
			[
				"xcrun devicectl device install app",
				writesJson({ result: { installedApplications: [{ bundleID: "com.x" }] } }),
			],
		]);
		const result = await devicectl.install("/b/App.app");
		expect(result).toEqual({ success: true, data: { bundleIds: ["com.x"] } });
		expect(joined(calls)[0]).toContain("install app --device");
	});

	test("isInstalled reads the apps listing for that bundle id", async () => {
		const present = tools([
			["xcrun devicectl device info apps", writesJson({ result: { apps: [{ bundleIdentifier: "com.x" }] } })],
		]);
		expect(await present.devicectl.isInstalled("com.x")).toEqual({ success: true, data: true });
		expect(joined(present.calls)[0]).toContain("--bundle-id com.x");
		const absent = tools([["xcrun devicectl device info apps", writesJson({ result: { apps: [] } })]]);
		expect(await absent.devicectl.isInstalled("com.x")).toEqual({ success: true, data: false });
	});

	test("appearance reads userInterfaceStyle", async () => {
		const { devicectl } = tools([
			["xcrun devicectl device info appearance", writesJson({ result: { userInterfaceStyle: "dark" } })],
		]);
		expect(await devicectl.appearance()).toEqual({ success: true, data: "dark" });
	});

	test("a locked phone is E_DEVICE_LOCKED, anything else E_IO", async () => {
		const locked = tools([
			["xcrun devicectl device orientation", { exitCode: 1, stderr: "ERROR: The device is locked. (Unlock it)" }],
		]);
		const lockedResult = await locked.devicectl.setOrientation("portrait");
		expect(!lockedResult.success && lockedResult.error).toMatchObject({ code: "E_DEVICE_LOCKED", retryable: false });
		const broken = tools([["xcrun devicectl device orientation", { exitCode: 1, stderr: "boom" }]]);
		const brokenResult = await broken.devicectl.setOrientation("portrait");
		expect(!brokenResult.success && brokenResult.error.code).toBe("E_IO");
	});

	test("pasteboard paste is stdout; copy goes through stdin", async () => {
		const { devicectl, calls } = tools([
			["xcrun devicectl device pasteboard paste", { stdout: "hello" }],
			["sh", {}],
		]);
		expect(await devicectl.pasteboardPaste()).toEqual({ success: true, data: "hello" });
		expect((await devicectl.pasteboardCopy("hello")).success).toBe(true);
		expect(joined(calls)[1]).toContain("pasteboard copy");
	});

	test("screenshot with a path writes there and answers the path", async () => {
		const { devicectl, calls } = tools([["xcrun devicectl device capture screenshot", {}]]);
		const result = await devicectl.screenshot("/out/s.png");
		expect(result).toEqual({ success: true, data: { path: "/out/s.png" } });
		expect(joined(calls)[0]).toContain("--destination /out/s.png");
	});
});
