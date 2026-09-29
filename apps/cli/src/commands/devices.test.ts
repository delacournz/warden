import { afterEach, describe, expect, test } from "bun:test";
import type { ExecResult } from "@warden/core/exec";
import { simctlDevicesJson } from "@warden/core/providers/ios.fixture";
import type { Owner } from "@warden/core/types";
import { fakeExec, type TestContext, testContext } from "../testing";
import { devicesCommand } from "./devices";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const other: Owner = { kind: "agent", sessionId: "s2", cwd: "/", repo: "warden", worktree: "cowrie@main" };

const IOS = simctlDevicesJson({
	"iOS-26-5": [
		{ udid: "U1", name: "warden-iphone-17-1", state: "Booted" },
		{ udid: "U2", name: "iPhone 17 Pro", state: "Shutdown" },
	],
});

function setup(argv: string[], opts: { adb?: boolean } = {}): TestContext {
	const adb = opts.adb ?? true;
	ctx = testContext(argv, {
		exec: fakeExec([
			["xcrun simctl list devices available -j", { stdout: IOS }],
			...(adb
				? ([
						[
							"adb devices -l",
							{ stdout: "List of devices attached\nemulator-5554          device product:sdk model:sdk\n\n" },
						],
						["adb -s emulator-5554 emu avd name", { stdout: "Pixel_10\r\nOK\r\n" }],
						["adb -s emulator-5554 shell getprop", { stdout: "35\n" }],
						["emulator -list-avds", { stdout: "Pixel_10\nPixel_9_Pro_Store\n" }],
					] satisfies Array<[string, Partial<ExecResult>]>)
				: []),
		]),
	});
	return ctx;
}

describe("warden devices", () => {
	test("lists every iOS sim (booted first, then shutdown), running emulators and AVDs, with lease owner", async () => {
		const c = setup(["--json"]);
		c.db.insertLease(
			{
				resource: { kind: "device", platform: "ios", id: "U1", name: "warden-iphone-17-1" },
				owner: other,
				ttlMs: 60_000,
			},
			c.now()
		);
		expect(await devicesCommand.run(c)).toBe(0);
		const rows = JSON.parse(c.stdout.join("\n"));
		expect(rows).toEqual([
			{
				platform: "android",
				name: "Pixel_10",
				id: "emulator-5554",
				state: "booted",
				runtime: "android-35",
				warden: false,
			},
			{ platform: "android", name: "Pixel_10", state: "avd", warden: false },
			{ platform: "android", name: "Pixel_9_Pro_Store", state: "avd", warden: false },
			{
				platform: "ios",
				name: "warden-iphone-17-1",
				id: "U1",
				state: "booted",
				runtime: "iOS-26-5",
				warden: true,
				lease: { id: expect.any(String), owner: "agent s2", where: "warden/cowrie@main" },
			},
			{ platform: "ios", name: "iPhone 17 Pro", id: "U2", state: "shutdown", runtime: "iOS-26-5", warden: false },
		]);
	});

	test("golden images are labelled, not counted as warden pool devices", async () => {
		ctx = testContext(["ios", "--json"], {
			exec: fakeExec([
				[
					"xcrun simctl list devices available -j",
					{
						stdout: simctlDevicesJson({
							"iOS-26-5": [{ udid: "G", name: "warden-golden-iphone-17-abc123def0", state: "Shutdown" }],
						}),
					},
				],
			]),
		});
		expect(await devicesCommand.run(ctx)).toBe(0);
		expect(JSON.parse(ctx.stdout.join("\n"))).toEqual([
			{
				platform: "ios",
				name: "warden-golden-iphone-17-abc123def0",
				id: "G",
				state: "shutdown",
				runtime: "iOS-26-5",
				warden: false,
				golden: true,
			},
		]);
		ctx.stdout.length = 0;
		ctx.argv = ["ios"];
		await devicesCommand.run(ctx);
		expect(ctx.stdout.join("\n")).toMatch(/warden-golden-iphone-17-abc123def0 .* golden/);
	});

	test("platform filter", async () => {
		const c = setup(["ios", "--json"]);
		expect(await devicesCommand.run(c)).toBe(0);
		const rows: Array<{ platform: string }> = JSON.parse(c.stdout.join("\n"));
		expect(rows.map((r) => r.platform)).toEqual(["ios", "ios"]);
	});

	test("text table", async () => {
		const c = setup(["ios"]);
		expect(await devicesCommand.run(c)).toBe(0);
		const text = c.stdout.join("\n");
		expect(text).toContain("PLATFORM");
		expect(text).toContain("iPhone 17 Pro");
		expect(text).toContain("warden-iphone-17-1");
	});

	test("unavailable platform tool → note on stderr, other platform still listed", async () => {
		const c = setup(["--json"], { adb: false });
		expect(await devicesCommand.run(c)).toBe(0);
		const rows: Array<{ platform: string }> = JSON.parse(c.stdout.join("\n"));
		expect(rows.map((r) => r.platform)).toEqual(["ios", "ios"]);
		expect(c.stderr.join("\n")).toContain("android: skipped");
	});

	test("bad platform / extra args → exit 1", async () => {
		const c = setup(["windows"]);
		expect(await devicesCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain('unknown platform "windows"');
		c.argv = ["ios", "android"];
		expect(await devicesCommand.run(c)).toBe(1);
	});

	test("is also reachable as `warden list`", () => {
		expect(devicesCommand.aliases).toEqual(["list"]);
	});
});
