import { describe, expect, test } from "bun:test";
import type { Exec, ExecResult } from "@delacour/warden-runtime/exec";
import { installer } from "./install";
import { type DeviceIo, installDevice } from "./install-device";

const UDID = "00008140-000A0B0C0D0E0F10";
const BUNDLE = "com.x.app";
const OK: ExecResult = { exitCode: 0, stdout: "", stderr: "" };

/** a devicectl host: the phone has `apps`; every call is recorded; a `--json-output` file is served from memory */
function host(state: {
	apps: Array<Record<string, unknown>>;
	fail?: (argv: readonly string[]) => ExecResult | undefined;
}) {
	const calls: string[][] = [];
	const files = new Map<string, string>();
	const io: DeviceIo = {
		tempDir: async () => "/tmp/dc",
		read: async (path) => files.get(path) ?? "",
		remove: async () => {},
	};
	const exec: Exec = async (argv) => {
		calls.push([...argv]);
		const failed = state.fail?.(argv);
		if (failed) return failed;
		const out = argv[argv.indexOf("--json-output") + 1];
		const verb = argv.slice(3, 5).join(" ");
		if (out === undefined) return OK;
		if (verb === "info apps") files.set(out, JSON.stringify({ result: { apps: state.apps } }));
		else {
			if (verb === "install app") state.apps = [{ bundleIdentifier: BUNDLE, bundleVersion: "7" }];
			if (verb === "uninstall app") state.apps = [];
			files.set(out, JSON.stringify({ result: {} }));
		}
		return OK;
	};
	return { exec, io, calls };
}

describe("devicectl argv", () => {
	test("install, info apps and uninstall name the device and a json file", async () => {
		const h = host({ apps: [] });
		await installDevice.install({ exec: h.exec, io: h.io }, UDID, "/c/App.app", BUNDLE);
		await installDevice.uninstall({ exec: h.exec, io: h.io }, UDID, BUNDLE);
		expect(h.calls).toEqual([
			[
				"xcrun",
				"devicectl",
				"device",
				"install",
				"app",
				"--device",
				UDID,
				"/c/App.app",
				"--json-output",
				"/tmp/dc/out.json",
			],
			[
				"xcrun",
				"devicectl",
				"device",
				"info",
				"apps",
				"--device",
				UDID,
				"--bundle-id",
				BUNDLE,
				"--json-output",
				"/tmp/dc/out.json",
			],
			[
				"xcrun",
				"devicectl",
				"device",
				"uninstall",
				"app",
				"--device",
				UDID,
				BUNDLE,
				"--json-output",
				"/tmp/dc/out.json",
			],
		]);
	});
});

describe("probePhone / installOnPhone", () => {
	test("absent, then present with the CFBundleVersion the phone reports", async () => {
		const h = host({ apps: [] });
		const deps = { exec: h.exec, io: h.io };
		expect(await installDevice.probe(deps, UDID, BUNDLE)).toEqual({ success: true, data: { present: false } });
		const done = await installDevice.install(deps, UDID, "/c/App.app", BUNDLE);
		expect(done).toEqual({ success: true, data: { present: true, version: "7" } });
	});

	test("an install that leaves a different bundle id on the phone is an error", async () => {
		const h = host({ apps: [] });
		const exec: Exec = async (argv) => {
			const res = await h.exec(argv);
			if (argv[3] === "install")
				await h.exec([
					"xcrun",
					"devicectl",
					"device",
					"uninstall",
					"app",
					"--device",
					UDID,
					BUNDLE,
					"--json-output",
					"/tmp/dc/out.json",
				]);
			return res;
		};
		const done = await installDevice.install({ exec, io: h.io }, UDID, "/c/App.app", BUNDLE);
		expect(!done.success && done.error).toContain("is not there");
	});

	test("an install failure is classified: locked phone, unlisted device, untrusted profile", () => {
		const fail = (stderr: string): ExecResult => ({ exitCode: 1, stdout: "", stderr });
		expect(
			installDevice.describeFailure("devicectl install app", fail("ERROR: The device is locked. (0x1)"))
		).toContain("device_locked");
		expect(
			installDevice.describeFailure(
				"devicectl install app",
				fail("Failed to verify code signature (0xe8008012): provisioning profile doesn't include this device")
			)
		).toContain("device_not_in_profile");
		expect(
			installDevice.describeFailure(
				"devicectl install app",
				fail("The profile has not been explicitly trusted by the user")
			)
		).toContain("runner_untrusted");
		expect(installDevice.describeFailure("devicectl install app", fail("something odd\nmore"))).toBe(
			"devicectl install app failed: something odd"
		);
	});

	test("a failing devicectl call surfaces the classified error", async () => {
		const h = host({ apps: [], fail: () => ({ exitCode: 1, stdout: "", stderr: "device is locked" }) });
		const res = await installDevice.install({ exec: h.exec, io: h.io }, UDID, "/c/App.app", BUNDLE);
		expect(!res.success && res.error).toContain("device_locked");
	});
});

describe("the shared installer on a physical iPhone", () => {
	const target = { platform: "ios", deviceId: UDID, physical: true } as const;

	test("probe, install and uninstall go through devicectl and never simctl", async () => {
		const h = host({ apps: [] });
		const deps = { exec: h.exec, env: {}, deviceIo: h.io };
		expect(await installer.probe(deps, target, BUNDLE)).toEqual({ success: true, data: { present: false } });
		const installed = await installer.installAndProbe(deps, target, "/c/App.app", BUNDLE);
		expect(installed.success && installed.data.version).toBe("7");
		expect((await installer.uninstall(deps, target, BUNDLE)).success).toBe(true);
		expect(h.calls.every((call) => call[1] === "devicectl")).toBe(true);
		expect(h.calls.some((call) => call.includes("uninstall"))).toBe(true);
	});

	test("data cannot be reset in place on a phone", async () => {
		const h = host({ apps: [{ bundleIdentifier: BUNDLE, bundleVersion: "7" }] });
		const res = await installer.resetAppData(
			{
				exec: h.exec,
				env: {},
				deviceIo: h.io,
				fs: { readdir: async () => [], rm: async () => {}, mkdir: async () => {} },
			},
			target,
			BUNDLE
		);
		expect(!res.success && res.error).toContain("reinstalls it");
		expect(h.calls).toEqual([]);
	});
});

describe("phoneAppMatches", () => {
	test("compares the phone's CFBundleVersion with the cached .app's", async () => {
		const plutil: Exec = async (argv) =>
			argv[0] === "plutil" && argv[1] === "-extract" && argv[2] === "CFBundleVersion"
				? { exitCode: 0, stdout: "7\n", stderr: "" }
				: { exitCode: 1, stdout: "", stderr: "" };
		expect(await installDevice.appBundleVersion(plutil, "/c/App.app")).toBe("7");
		expect(await installDevice.appMatches(plutil, "/c/App.app", { present: true, version: "7" })).toBe(true);
		expect(await installDevice.appMatches(plutil, "/c/App.app", { present: true, version: "6" })).toBe(false);
		expect(await installDevice.appMatches(plutil, "/c/App.app", { present: true })).toBe(false);
	});
});
