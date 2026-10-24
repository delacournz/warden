import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeExec, type TestContext, testContext } from "../testing";
import { type DoctorCheck, perfDoctor } from "./doctor";
import { asMe, fakePerfDeps } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const fx = (name: string) =>
	readFileSync(join(import.meta.dir, "..", "..", "..", "..", "packages", "perf", "fixtures", name), "utf8");

const sim = { platform: "ios", id: "U1", name: "warden-iphone-17-1" } as const;
const emu = { platform: "android", id: "emulator-5554", name: "Pixel_8" } as const;

type Handler = Array<[string, { stdout?: string; exitCode?: number }]>;

const HOST_OK: Handler = [
	["xcrun xctrace version", { stdout: fx("xctrace-version.txt") }],
	["xcodebuild -version", { stdout: "Xcode 26.3\nBuild version 17C529\n" }],
	["adb version", { stdout: fx("adb-version.txt") }],
];

function setup(
	device: typeof sim | typeof emu | undefined,
	handlers: Handler,
	host: Parameters<typeof fakePerfDeps>[2] = {}
) {
	const c = testContext([], { exec: fakeExec(handlers) });
	ctx = c;
	asMe(c);
	if (device) c.db.recordDevice({ platform: device.platform, id: device.id, name: device.name }, c.now());
	return { c, deps: fakePerfDeps(device ? [device] : [], {}, host) };
}

async function run(c: TestContext, deps: ReturnType<typeof fakePerfDeps>, opts: Record<string, unknown> = {}) {
	const code = await perfDoctor(c, deps, { record: true, json: true, ...opts });
	const doc = JSON.parse(c.stdout.join("\n"));
	const byId: Record<string, DoctorCheck> = Object.fromEntries((doc.checks as DoctorCheck[]).map((k) => [k.id, k]));
	return { code, doc, byId };
}

describe("warden perf doctor: host tools", () => {
	test("a healthy macOS host with an iOS sim", async () => {
		const { c, deps } = setup(sim, HOST_OK, { metro: async () => "http://127.0.0.1:8081" });
		const { code, byId, doc } = await run(c, deps, { app: "com.acme.shop" });
		expect(code).toBe(0);
		expect(doc.ok).toBe(true);
		expect(byId.xctrace).toMatchObject({ status: "ok", detail: "27.1" });
		expect(byId.xcode).toMatchObject({ status: "ok" });
		expect(byId.adb).toMatchObject({ status: "ok", detail: "1.0.41" });
		expect(byId["device-tools"].status).toBe("skip");
		expect(byId.metro).toMatchObject({ status: "ok", detail: "http://127.0.0.1:8081" });
		expect(byId.app).toMatchObject({ status: "ok" });
		expect(doc.device).toMatchObject({ udid: "U1" });
	});

	test("xctrace missing fails the doctor with an install hint", async () => {
		const { c, deps } = setup(sim, [["xcrun xctrace version", { exitCode: 1 }], ...HOST_OK]);
		const { code, byId, doc } = await run(c, deps, { app: "a.b" });
		expect(code).toBe(1);
		expect(doc.ok).toBe(false);
		expect(byId.xctrace.status).toBe("fail");
		expect(byId.xctrace.hint).toContain("xcode-select");
	});

	test("Xcode 26.4+ warns about the xctrace --device deadlock", async () => {
		const { c, deps } = setup(sim, [
			["xcodebuild -version", { stdout: "Xcode 26.4.1\nBuild version 17E1\n" }],
			...HOST_OK,
		]);
		const { byId, code } = await run(c, deps, { app: "a.b" });
		expect(code).toBe(0);
		expect(byId.xcode.status).toBe("warn");
		expect(byId.xcode.detail).toContain("26.4.1");
		expect(byId.xcode.hint).toContain("--all-processes");
	});

	test("off macOS the Xcode checks are skipped", async () => {
		const { c, deps } = setup(emu, HOST_OK, { platform: "linux" });
		const { byId } = await run(c, deps, { app: "a.b" });
		expect(byId.xctrace.status).toBe("skip");
		expect(byId.xcode.status).toBe("skip");
	});

	test("adb missing is a warning, not a failure (Android is optional)", async () => {
		const { c, deps } = setup(sim, [["adb version", { exitCode: 127 }], ...HOST_OK]);
		const { byId, code } = await run(c, deps, { app: "a.b" });
		expect(byId.adb.status).toBe("warn");
		expect(code).toBe(0);
	});

	test("trace_processor: warn when not cached, ok when cached", async () => {
		const { c, deps } = setup(sim, HOST_OK);
		const missing = await run(c, deps, { app: "a.b" });
		expect(missing.byId["trace-processor"]).toMatchObject({ status: "warn" });
		expect(missing.byId["trace-processor"].hint).toContain("warden perf tools install trace-processor");
		c.stdout.length = 0;
		const tools = join(c.env.WARDEN_HOME ?? "", "tools");
		mkdirSync(tools, { recursive: true });
		writeFileSync(join(tools, "trace_processor_shell-v50.0"), "x");
		const cached = await run(c, deps, { app: "a.b" });
		expect(cached.byId["trace-processor"]).toMatchObject({ status: "ok", detail: expect.stringContaining("v50.0") });
	});
});

describe("warden perf doctor: device checks", () => {
	test("Android: missing simpleperf warns; perfetto present", async () => {
		const handlers: Handler = [
			["adb -s emulator-5554 shell which perfetto simpleperf", { stdout: fx("adb-which-perfetto.txt") }],
			["adb -s emulator-5554 shell dumpsys package com.acme.shop", { stdout: fx("dumpsys-package-debuggable.txt") }],
			...HOST_OK,
		];
		const { c, deps } = setup(emu, handlers);
		const { byId, code } = await run(c, deps, { app: "com.acme.shop" });
		expect(code).toBe(0);
		expect(byId["device-tools"]).toMatchObject({ status: "warn" });
		expect(byId["device-tools"].detail).toContain("perfetto");
		expect(byId["device-tools"].hint).toContain("simpleperf");
		expect(byId.app).toMatchObject({ status: "ok", detail: expect.stringContaining("debuggable") });
	});

	test("Android release build: warns with the profileable manifest snippet", async () => {
		const handlers: Handler = [
			["adb -s emulator-5554 shell which", { stdout: fx("adb-which-both.txt") }],
			["adb -s emulator-5554 shell dumpsys package com.acme.shop", { stdout: fx("dumpsys-package-release.txt") }],
			...HOST_OK,
		];
		const { c, deps } = setup(emu, handlers);
		const { byId } = await run(c, deps, { app: "com.acme.shop" });
		expect(byId["device-tools"].status).toBe("ok");
		expect(byId.app.status).toBe("warn");
		expect(byId.app.hint).toContain('<profileable android:shell="true"/>');
	});

	test("the app is detected when --app is absent", async () => {
		const { c, deps } = setup(sim, [
			["xcrun simctl spawn U1 launchctl list", { stdout: fx("launchctl-list.txt") }],
			...HOST_OK,
		]);
		const { byId } = await run(c, deps);
		expect(byId.app.detail).toContain("nz.co.delacour.warden.example");
	});

	test("no device to inspect: device checks are skipped with the reason, host checks still run", async () => {
		const { c, deps } = setup(undefined, HOST_OK);
		const { byId, code, doc } = await run(c, deps);
		expect(code).toBe(0);
		expect(doc.device).toBeUndefined();
		expect(byId["device-tools"].status).toBe("skip");
		expect(byId.app.status).toBe("skip");
		expect(byId.app.detail).toContain("no booted warden device");
		expect(byId.xctrace.status).toBe("ok");
	});

	test("never leases the device it inspects", async () => {
		const { c, deps } = setup(sim, HOST_OK);
		await run(c, deps, { app: "a.b" });
		expect(c.db.listLeases()).toEqual([]);
	});
});

describe("warden perf doctor: text mode", () => {
	test("prints one line per check with a status glyph word", async () => {
		const { c, deps } = setup(sim, HOST_OK);
		const code = await perfDoctor(c, deps, { record: true, app: "a.b" });
		expect(code).toBe(0);
		const text = c.stdout.join("\n");
		expect(text).toContain("xctrace");
		expect(text).toContain("trace-processor");
	});
});
