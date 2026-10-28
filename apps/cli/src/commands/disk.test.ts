import { afterEach, describe, expect, test } from "bun:test";
import type { ExecResult } from "@delacour/warden-core/exec";
import { type FixtureSim, simctlDevicesJson } from "@delacour/warden-core/providers/ios.fixture";
import { fakeExec, type TestContext, testContext } from "../testing";
import { diskCommand } from "./disk";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const GB_BLOCKS = 1024 ** 2;
const DAY_MS = 86_400_000;
const NOW = 100 * DAY_MS;

const dfRow = (totalGb: number, freeGb: number): string =>
	`Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 ${totalGb * GB_BLOCKS} 1 ${freeGb * GB_BLOCKS} 90% /System/Volumes/Data\n`;

type Host = {
	totalGb?: number;
	freeGb?: number;
	swap?: string;
	snapshots?: string;
	bootDays?: number;
	sims?: FixtureSim[];
};

function hostExec(host: Host) {
	const sims = simctlDevicesJson({ "iOS-26-5": host.sims ?? [] });
	const handlers: Array<[string, Partial<ExecResult>]> = [
		["df -Pk", { stdout: dfRow(host.totalGb ?? 500, host.freeGb ?? 300) }],
		["sysctl -n vm.swapusage", { stdout: host.swap ?? "total = 2.00G  used = 0.50G  free = 1.50G  (encrypted)" }],
		["tmutil listlocalsnapshots /", { stdout: host.snapshots ?? "Snapshots for disk /:\n" }],
		["sysctl -n kern.boottime", { stdout: `{ sec = ${(NOW - (host.bootDays ?? 1) * DAY_MS) / 1000}, usec = 0 }` }],
		["sysctl -n kern.memorystatus_vm_pressure_level", { stdout: "1\n" }],
		["xcrun simctl list devices", { stdout: sims }],
	];
	return fakeExec(handlers);
}

function setup(argv: string[], host: Host, env: Record<string, string> = {}): TestContext {
	ctx = testContext(argv, { exec: hostExec(host), now: () => NOW });
	ctx.env = { ...ctx.env, ...env };
	return ctx;
}

function json(c: TestContext) {
	return JSON.parse(c.stdout.join("\n"));
}

describe("warden disk", () => {
	test("healthy host: level ok, no reasons, thresholds shown", async () => {
		const c = setup(["--json"], {});
		expect(await diskCommand.run(c)).toBe(0);
		const out = json(c);
		expect(out.level).toBe("ok");
		expect(out.reasons).toEqual([]);
		expect(out.enabled).toBe(true);
		expect(out.free).toEqual({ freeBytes: 300 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 });
		expect(out.swapUsedBytes).toBe(0.5 * 1024 ** 3);
		expect(out.snapshots).toEqual({ osUpdate: 0, timeMachine: 0 });
		expect(out.uptimeDays).toBe(1);
		expect(out.pressure).toBe("normal");
		expect(out.thresholds).toEqual({
			floorBytes: 50 * 1024 ** 3,
			criticalBytes: 20 * 1024 ** 3,
			swapWarnBytes: 8 * 1024 ** 3,
		});
		expect(out.devices).toEqual({ booted: 0, estMemMb: 0 });
		expect(out.reclaimable).toEqual([]);
	});

	test("sick host: every reason carries a fix, memory reasons first", async () => {
		const c = setup(["--json"], {
			freeGb: 10,
			swap: "total = 30.00G  used = 25.00G  free = 5.00G  (encrypted)",
			snapshots: "Snapshots for disk /:\ncom.apple.os.update-ABC\ncom.apple.TimeMachine.2026-10-01-000000.local\n",
			bootDays: 9,
		});
		expect(await diskCommand.run(c)).toBe(0);
		const out = json(c);
		expect(out.level).toBe("critical");
		const kinds = out.reasons.map((r: { kind: string }) => r.kind);
		expect(kinds).toEqual(["swap", "os-update-snapshots", "tm-snapshots", "low-free", "uptime"]);
		for (const r of out.reasons) expect(r.fix.length).toBeGreaterThan(0);
		const fix = (kind: string): string => out.reasons.find((r: { kind: string }) => r.kind === kind).fix;
		expect(fix("swap")).toContain("warden gc --idle 0");
		expect(fix("tm-snapshots")).toContain("sudo tmutil");
		expect(fix("low-free")).toContain("warden builds rm");
		expect(fix("low-free")).toContain("warden sims prune");
	});

	test("text: swap and snapshot warnings lead with the file-deletion caveat", async () => {
		const c = setup([], { swap: "total = 30.00G  used = 25.00G  free = 5.00G  (encrypted)", freeGb: 30 });
		expect(await diskCommand.run(c)).toBe(0);
		const text = c.stdout.join("\n");
		expect(text).toContain("deleting files won't stop swap refilling the disk");
		expect(text.indexOf("deleting files")).toBeLessThan(text.indexOf("warden gc --idle 0"));
		expect(text).toContain("thresholds");
	});

	test("text: no caveat when only free space is low", async () => {
		const c = setup([], { freeGb: 30 });
		expect(await diskCommand.run(c)).toBe(0);
		const text = c.stdout.join("\n");
		expect(text).not.toContain("deleting files");
		expect(text).toContain("warden sims prune");
	});

	test("env overrides thresholds; WARDEN_DISK=off flagged", async () => {
		const c = setup(["--json"], { freeGb: 30 }, { WARDEN_DISK_FLOOR_GB: "25", WARDEN_DISK: "off" });
		expect(await diskCommand.run(c)).toBe(0);
		const out = json(c);
		expect(out.enabled).toBe(false);
		expect(out.thresholds.floorBytes).toBe(25 * 1024 ** 3);
		expect(out.level).toBe("ok");
	});

	test("a bad override is warned about on stderr and ignored", async () => {
		const c = setup(["--json"], {}, { WARDEN_DISK_FLOOR_GB: "lots" });
		expect(await diskCommand.run(c)).toBe(0);
		expect(c.stderr.join("\n")).toContain("WARDEN_DISK_FLOOR_GB=lots");
	});

	test("reclaimable: build cache vs cap and deletable sims", async () => {
		const c = setup(
			["--json"],
			{ sims: [{ udid: "U1", name: "warden-iphone-17-1", state: "Shutdown", dataPathSize: 2 * 1024 ** 3 }] },
			{
				WARDEN_MAX_CACHE_SIZE: "1M",
			}
		);
		c.db.db.run(
			"INSERT INTO builds (project_key, platform, profile, hash, path, source, size, created_at, last_used_at) VALUES ('k','ios','p','h','/x','eas',?,1,1)",
			[5 * 1024 ** 2]
		);
		expect(await diskCommand.run(c)).toBe(0);
		const { reclaimable } = json(c);
		const builds = reclaimable.find((r: { kind: string }) => r.kind === "builds");
		expect(builds).toMatchObject({
			kind: "builds",
			bytes: 5 * 1024 ** 2,
			capBytes: 1024 ** 2,
			overCapBytes: 4 * 1024 ** 2,
		});
		const sims = reclaimable.find((r: { kind: string }) => r.kind === "sims");
		expect(sims).toMatchObject({ kind: "sims", count: 1 });
		expect(sims.bytes).toBeGreaterThan(0);
	});

	test("a host whose probes all fail still reports, with nothing to warn about", async () => {
		ctx = testContext(["--json"], { now: () => NOW });
		expect(await diskCommand.run(ctx)).toBe(0);
		const out = json(ctx);
		expect(out.level).toBe("ok");
		expect(out.free).toBeNull();
		expect(out.pressure).toBe("unknown");
	});
});
