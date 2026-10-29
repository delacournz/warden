import { afterEach, describe, expect, test } from "bun:test";
import type { ExecResult } from "@delacour/warden-core/exec";
import { simctlDevicesJson } from "@delacour/warden-core/providers/ios.fixture";
import type { Owner } from "@delacour/warden-core/types";
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

	test("quarantine + slim state show on warden devices", async () => {
		const c = setup(["ios", "--json"], { adb: false });
		c.db.recordDevice({ platform: "ios", id: "U1", name: "warden-iphone-17-1", profile: "iphone-17" }, 0);
		c.db.quarantineDevice({ platform: "ios", id: "U1", name: "warden-iphone-17-1" }, "hung", 3);
		c.db.setSlimmed("ios", "U1", 4);
		expect(await devicesCommand.run(c)).toBe(0);
		const rows: Array<{ id: string; quarantined?: { reason?: string }; slimmed?: true }> = JSON.parse(
			c.stdout.join("\n")
		);
		expect(rows.find((r) => r.id === "U1")).toMatchObject({ quarantined: { reason: "hung" }, slimmed: true });
		expect(rows.find((r) => r.id === "U2")?.quarantined).toBeUndefined();
		c.stdout.length = 0;
		c.argv = ["ios"];
		await devicesCommand.run(c);
		expect(c.stdout.join("\n")).toMatch(/warden-iphone-17-1 .* yes quarantined slim/);
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

	test("table: no LEASED BY column — a leased device says so in STATE with its owner", async () => {
		const c = setup([]);
		c.db.insertLease(
			{
				resource: { kind: "device", platform: "ios", id: "U1", name: "warden-iphone-17-1" },
				owner: other,
				ttlMs: 60_000,
			},
			c.now()
		);
		expect(await devicesCommand.run(c)).toBe(0);
		const text = c.stdout.join("\n");
		expect(text).not.toContain("LEASED BY");
		expect(text.split("\n")[0]).toMatch(/^PLATFORM\s+NAME\s+ID\s+STATE\s+RUNTIME\s+WARDEN$/);
		expect(text).toMatch(/warden-iphone-17-1\s+U1\s+leased · agent s2/);
	});

	test("--mem measures booted iOS sims with one ps/top snapshot and adds footprintMb / an MB column", async () => {
		const calls: string[][] = [];
		ctx = testContext(["ios", "--mem", "--json"], {
			exec: fakeExec(
				[
					["xcrun simctl list devices available -j", { stdout: IOS }],
					["pgrep -f U1/data", { stdout: "100\n" }],
					["ps", { stdout: "  PID  PPID COMM\n 100 1 /x/launchd_sim\n 101 100 /x/backboardd\n" }],
					["top", { stdout: "PID MEM\n100 2M\n101 168M+\n" }],
				],
				calls
			),
		});
		expect(await devicesCommand.run(ctx)).toBe(0);
		const rows = JSON.parse(ctx.stdout.join("\n"));
		expect(rows.find((r: { id: string }) => r.id === "U1").footprintMb).toBe(170);
		expect(rows.find((r: { id: string }) => r.id === "U2").footprintMb).toBeUndefined();
		expect(calls.filter((c) => c[0] === "ps" || c[0] === "top").length).toBe(2);
		ctx.cleanup();

		ctx = testContext(["ios", "--mem"], {
			exec: fakeExec([
				["xcrun simctl list devices available -j", { stdout: IOS }],
				["pgrep -f U1/data", { stdout: "100\n" }],
				["ps", { stdout: "  PID  PPID COMM\n 100 1 /x/launchd_sim\n" }],
				["top", { stdout: "PID MEM\n100 2M\n" }],
			]),
		});
		expect(await devicesCommand.run(ctx)).toBe(0);
		expect(ctx.stdout.join("\n")).toContain("MB");
	});

	test("without --mem nothing is measured", async () => {
		const calls: string[][] = [];
		ctx = testContext(["ios", "--json"], {
			exec: fakeExec([["xcrun simctl list devices available -j", { stdout: IOS }]], calls),
		});
		await devicesCommand.run(ctx);
		expect(calls.some((c) => c[0] === "pgrep")).toBe(false);
	});
});

describe("warden devices (physical phones)", () => {
	test("a phone is listed with physical: true and a physical WARDEN cell", async () => {
		ctx = testContext(["android", "--json"], {
			exec: fakeExec([
				["adb devices -l", { stdout: "List of devices attached\nR5CT1234ABC device usb:1-1 model:SM_A546E\n\n" }],
				["adb -s R5CT1234ABC shell getprop ro.boot.qemu", { stdout: "\n\nR5CT1234ABC\nSM-A546E\n34\n" }],
				["emulator -list-avds", { stdout: "" }],
			]),
		});
		expect(await devicesCommand.run(ctx)).toBe(0);
		const rows: Array<{ id?: string }> = JSON.parse(ctx.stdout.join("\n"));
		const phone = rows.find((r) => r.id === "R5CT1234ABC");
		expect(phone).toMatchObject({
			platform: "android",
			name: "SM-A546E",
			state: "booted",
			physical: true,
			warden: false,
		});
	});
});
