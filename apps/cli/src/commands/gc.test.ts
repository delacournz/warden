import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listBuilds, storeArtifact } from "@delacour/warden-core/builds/cache";
import { recordCondition } from "@delacour/warden-core/conditions/conditions";
import type { Exec } from "@delacour/warden-core/exec";
import type { Owner } from "@delacour/warden-core/types";
import { fakeSimctl, wardenSim } from "../simctl.testing";
import { fakeExec, scriptedUi, type TestContext, testContext } from "../testing";
import { gcCommand } from "./gc";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const NOW = 100 * 60_000;
const agent: Owner = { kind: "agent", sessionId: "a", cwd: "/" };

function setup(argv: string[], calls: string[][]): TestContext {
	ctx = testContext(argv, {
		now: () => NOW,
		exec: fakeSimctl(
			[
				{ udid: "U1", name: "warden-iphone-17-1", state: "Booted" },
				{ udid: "U2", name: "warden-iphone-17-2", state: "Booted" },
				{ udid: "U3", name: "warden-iphone-17-3", state: "Booted" },
				{ udid: "U4", name: "warden-iphone-17-4", state: "Shutdown" },
				{ udid: "F", name: "iPhone 17", state: "Booted" },
			],
			calls
		),
	});
	const db = ctx.db;
	db.recordDevice({ platform: "ios", id: "U1", name: "warden-iphone-17-1" }, 0);
	db.recordDevice({ platform: "ios", id: "U2", name: "warden-iphone-17-2" }, 0);
	db.recordDevice({ platform: "ios", id: "U3", name: "warden-iphone-17-3" }, NOW - 60_000);
	db.recordDevice({ platform: "ios", id: "U4", name: "warden-iphone-17-4" }, 0);
	db.insertLease(
		{
			resource: { kind: "device", platform: "ios", id: "U2", name: "warden-iphone-17-2" },
			owner: agent,
			ttlMs: 60_000,
		},
		NOW
	);
	db.insertLease({ resource: { kind: "port", port: 9 }, owner: agent, ttlMs: 1 }, 0);
	return ctx;
}

describe("warden gc", () => {
	test("reclaims stale leases, shuts down idle unleased warden devices only", async () => {
		const calls: string[][] = [];
		const c = setup(["--json"], calls);
		expect(await gcCommand.run(c)).toBe(0);
		const out = JSON.parse(c.stdout.join("\n"));
		expect(out.reclaimed).toHaveLength(1);
		expect(out.shutdown).toEqual([{ platform: "ios", id: "U1", name: "warden-iphone-17-1" }]);
		const shutdowns = calls.filter((x) => x[1] === "simctl" && x[2] === "shutdown").map((x) => x[3]);
		expect(shutdowns).toEqual(["U1"]);
		expect(calls.some((x) => x.includes("delete") || x.includes("erase"))).toBe(false);
		expect(c.db.listLeases().map((l) => l.resource)).toMatchObject([{ id: "U2" }]);
	});

	test("undoes the orphaned conditions of an unleased device, and leaves a leased device's alone", async () => {
		const calls: string[][] = [];
		const c = setup(["--json"], calls);
		c.exec = fakeSimctl([{ udid: "U1", name: "warden-iphone-17-1", state: "Booted" }], calls, [
			["xcrun simctl status_bar", {}],
		]);
		const l = c.db.insertLease(
			{ resource: { kind: "device", platform: "ios", id: "U1", name: "U1" }, owner: agent, ttlMs: 1 },
			0
		);
		recordCondition(c.db, l.id, "battery", { level: 5, charging: false, cosmetic: true }, 1);
		c.db.db.exec(`DELETE FROM leases WHERE id = '${l.id}'`);
		c.db.db.exec(
			"INSERT INTO orphan_conditions VALUES ('ios', 'U2', 'battery', 'old', '{\"level\":5,\"charging\":false,\"cosmetic\":true}', '[]', 1, 1)"
		);
		expect(await gcCommand.run(c)).toBe(0);
		const cleared = calls.filter((x) => x[2] === "status_bar" && x[4] === "clear").map((x) => x[3]);
		expect(cleared).toEqual(["U1"]);
		expect(c.db.db.query("SELECT device_id FROM orphan_conditions").all()).toEqual([{ device_id: "U2" }]);
	});

	test("an idle sim it shut down loses its viewer window too (Device Hub keeps a page open)", async () => {
		const calls: string[][] = [];
		ctx = testContext(["--json"], {
			now: () => NOW,
			exec: fakeSimctl([wardenSim(1, "Booted")], calls, [
				["pgrep -xq Simulator", { exitCode: 1 }],
				["pgrep -xq DeviceHub", { exitCode: 0 }],
				["osascript", {}],
			]),
		});
		ctx.db.recordDevice({ platform: "ios", id: "U1", name: "warden-iphone-17-1" }, 0);
		expect(await gcCommand.run(ctx)).toBe(0);
		const closes = calls.filter((x) => x[0] === "osascript" && (x[4] ?? "").includes("AXCloseButton"));
		expect(closes.map((x) => JSON.parse(x[5] ?? ""))).toEqual([["warden-iphone-17-1"]]);
		expect(calls.indexOf(closes[0] as string[])).toBeGreaterThan(calls.findIndex((x) => x[2] === "shutdown"));
	});

	test("--idle shortens the idle window", async () => {
		const calls: string[][] = [];
		const c = setup(["--idle", "30s"], calls);
		expect(await gcCommand.run(c)).toBe(0);
		const shutdowns = calls.filter((x) => x[1] === "simctl" && x[2] === "shutdown").map((x) => x[3]);
		expect(shutdowns.sort()).toEqual(["U1", "U3"]);
	});

	test("bad --idle / unknown option → exit 1", async () => {
		const c = setup(["--idle", "soon"], []);
		expect(await gcCommand.run(c)).toBe(1);
		c.argv = ["--bogus"];
		expect(await gcCommand.run(c)).toBe(1);
	});

	test("spinner covers the shutdowns; simctl progress would print above it", async () => {
		const c = setup([], []);
		const ui = scriptedUi();
		c.ui = ui;
		expect(await gcCommand.run(c)).toBe(0);
		expect(ui.events).toEqual(["spin: shutting down idle devices…", "stop"]);
		expect(c.stdout.join("\n")).toContain("shut down warden-iphone-17-1");
	});

	test("forgets android records whose emulator is gone (unleased); keeps leased ones", async () => {
		ctx = testContext(["--json"], {
			now: () => NOW,
			exec: fakeExec([["adb devices -l", { stdout: "List of devices attached\n\n" }]]),
		});
		ctx.db.recordDevice({ platform: "android", id: "emulator-5554", name: "warden-pixel-10-1" }, 0);
		ctx.db.recordDevice({ platform: "android", id: "emulator-5556", name: "warden-pixel-10-2" }, 0);
		ctx.db.insertLease(
			{
				resource: { kind: "device", platform: "android", id: "emulator-5556", name: "warden-pixel-10-2" },
				owner: agent,
				ttlMs: 60_000,
			},
			NOW
		);
		expect(await gcCommand.run(ctx)).toBe(0);
		expect(ctx.db.listDevices("android").map((d) => d.id)).toEqual(["emulator-5556"]);
		expect(JSON.parse(ctx.stdout.join("\n")).forgotten).toEqual([
			{ platform: "android", id: "emulator-5554", name: "warden-pixel-10-1" },
		]);
	});

	test("stale lease of a crashed session → device shut down if that session booted it; foreign running one left alone", async () => {
		const calls: string[][] = [];
		const c = setup(["--json"], calls);
		c.db.insertLease(
			{
				resource: { kind: "device", platform: "ios", id: "F", name: "iPhone 17" },
				owner: agent,
				ttlMs: 1,
				bootedByOwner: true,
			},
			0
		);
		expect(await gcCommand.run(c)).toBe(0);
		const out = JSON.parse(c.stdout.join("\n"));
		expect(out.shutdown.map((d: { id: string }) => d.id)).toContain("F");
		expect(calls.filter((x) => x[2] === "shutdown").map((x) => x[3])).toContain("F");
	});

	function staleF(c: TestContext, heartbeatAt: number): void {
		c.db.insertLease(
			{
				resource: { kind: "device", platform: "ios", id: "F", name: "iPhone 17" },
				owner: agent,
				ttlMs: 60_000,
				bootedByOwner: true,
			},
			heartbeatAt
		);
	}

	test("lease stale < 10 min → lease reclaimed but device kept running", async () => {
		const calls: string[][] = [];
		const c = setup(["--json", "--idle", "0s"], calls);
		staleF(c, NOW - 5 * 60_000 - 60_000);
		expect(await gcCommand.run(c)).toBe(0);
		const out = JSON.parse(c.stdout.join("\n"));
		expect(out.reclaimed.length).toBe(2);
		expect(c.db.listLeases().map((l) => l.resource)).not.toContainEqual(expect.objectContaining({ id: "F" }));
		expect(calls.filter((x) => x[2] === "shutdown").map((x) => x[3])).not.toContain("F");
		expect(out.notes.join("\n")).toContain("grace");
	});

	test("lease stale > 10 min but non-Apple app running → device kept", async () => {
		const calls: string[][] = [];
		const c = setup(["--json"], calls);
		staleF(c, NOW - 30 * 60_000);
		c.exec = fakeExec(
			[
				["xcrun simctl spawn F launchctl list", { stdout: "9\t0\tUIKitApplication:com.acme.app[0x1]" }],
				["xcrun simctl", {}],
			],
			calls
		);
		expect(await gcCommand.run(c)).toBe(0);
		expect(calls.filter((x) => x[2] === "shutdown").map((x) => x[3])).not.toContain("F");
		expect(JSON.parse(c.stdout.join("\n")).notes.join("\n")).toContain("app is running");
	});

	test("--quiet prints nothing; last run recorded", async () => {
		const c = setup(["--quiet"], []);
		const ui = scriptedUi();
		c.ui = ui;
		expect(await gcCommand.run(c)).toBe(0);
		expect(c.stdout).toEqual([]);
		expect(ui.events).toEqual([]);
		expect(c.db.getMeta("last_gc_at")).toBe(String(NOW));
	});
});

describe("warden gc: build cache prune (17-11)", () => {
	const MIN = 60_000;
	/** a cached `.app` of `bytes` bytes, last used at `usedAt` */
	async function seed(c: TestContext, hash: string, bytes: number, usedAt: number): Promise<string> {
		const app = join(c.cwd, "src", hash, "App.app");
		mkdirSync(app, { recursive: true });
		writeFileSync(join(app, "App"), "x".repeat(bytes));
		const res = await storeArtifact({
			store: c.db,
			env: c.env,
			projectKey: "k",
			platform: "ios",
			profile: "local",
			hash,
			artifact: app,
			source: "build",
			now: usedAt,
		});
		if (!res.success) throw new Error(res.error);
		return res.data.path;
	}

	test("prunes the least-recently-used builds down to --max-cache-size and reports them", async () => {
		const c = setup(["--json", "--max-cache-size", "250"], []);
		const old = await seed(c, "old", 100, 1);
		await seed(c, "mid", 100, 2);
		await seed(c, "new", 100, 3);
		expect(await gcCommand.run(c)).toBe(0);
		expect(
			listBuilds(c.db)
				.map((b) => b.hash)
				.sort()
		).toEqual(["mid", "new"]);
		expect(existsSync(old)).toBe(false);
		const out = JSON.parse(c.stdout.join("\n"));
		expect(out.notes.join("\n")).toContain("pruned 1 cached build");
	});

	test("WARDEN_MAX_CACHE_SIZE sets the cap; a build used in the last 30 min is kept even over it", async () => {
		const c = setup(["--json"], []);
		c.env.WARDEN_MAX_CACHE_SIZE = "0";
		await seed(c, "old", 100, NOW - 31 * MIN);
		await seed(c, "hot", 100, NOW - 29 * MIN);
		expect(await gcCommand.run(c)).toBe(0);
		expect(listBuilds(c.db).map((b) => b.hash)).toEqual(["hot"]);
	});

	test("under the default 20 GB cap nothing is pruned and nothing is reported", async () => {
		const c = setup(["--json"], []);
		await seed(c, "a", 100, 1);
		expect(await gcCommand.run(c)).toBe(0);
		expect(listBuilds(c.db)).toHaveLength(1);
		expect(JSON.parse(c.stdout.join("\n")).notes.join("\n")).not.toContain("pruned");
	});

	test("--quiet (auto-gc) prunes too", async () => {
		const c = setup(["--quiet", "--max-cache-size", "0"], []);
		await seed(c, "a", 100, 1);
		expect(await gcCommand.run(c)).toBe(0);
		expect(listBuilds(c.db)).toEqual([]);
	});

	test("a bad --max-cache-size → exit 1, nothing pruned", async () => {
		const c = setup(["--max-cache-size", "lots"], []);
		await seed(c, "a", 100, 1);
		expect(await gcCommand.run(c)).toBe(1);
		expect(listBuilds(c.db)).toHaveLength(1);
	});

	test("a bad WARDEN_MAX_CACHE_SIZE skips only the prune, with a note: leases and idle devices are still handled (R5)", async () => {
		const c = setup(["--json"], []);
		c.env.WARDEN_MAX_CACHE_SIZE = "20GBs";
		await seed(c, "a", 100, 1);
		expect(await gcCommand.run(c)).toBe(0);
		expect(listBuilds(c.db)).toHaveLength(1);
		const out = JSON.parse(c.stdout.join("\n"));
		expect(out.reclaimed).toHaveLength(1);
		expect(out.notes.join("\n")).toContain("WARDEN_MAX_CACHE_SIZE");
		expect(out.notes.join("\n")).toContain("build cache prune skipped");
		expect(out.shutdown).toEqual([{ platform: "ios", id: "U1", name: "warden-iphone-17-1" }]);
	});
});

describe("warden gc: parallel shutdown", () => {
	/** `base` with every `simctl shutdown` taking `ms`, counting how many are under way at once */
	function slowShutdowns(base: Exec, ms: number): { exec: Exec; peak: () => number; order: string[] } {
		let running = 0;
		let peak = 0;
		const order: string[] = [];
		const exec: Exec = async (cmd, opts) => {
			if (cmd[1] !== "simctl" || cmd[2] !== "shutdown") return base(cmd, opts);
			running++;
			peak = Math.max(peak, running);
			order.push(cmd[3] ?? "");
			await Bun.sleep(ms);
			running--;
			return base(cmd, opts);
		};
		return { exec, peak: () => peak, order };
	}

	/** ten idle booted warden sims, plus: a leased one, a recently used one, an idle one already shut down, a foreign booted one */
	function crowd(extra: Array<[string, { exitCode?: number; stderr?: string }]> = []) {
		const calls: string[][] = [];
		const idle = Array.from({ length: 10 }, (_, i) => wardenSim(10 + i, "Booted"));
		const sims = [
			...idle,
			wardenSim(1, "Booted"),
			wardenSim(2, "Booted"),
			wardenSim(3, "Shutdown"),
			{ udid: "FOREIGN", name: "iPhone 17", state: "Booted" as const },
		];
		const c = testContext(["--json"], { now: () => NOW, exec: fakeSimctl(sims, calls, extra) });
		ctx = c;
		for (const sim of idle) c.db.recordDevice({ platform: "ios", id: sim.udid, name: sim.name }, 0);
		c.db.recordDevice({ platform: "ios", id: "U1", name: "warden-iphone-17-1" }, 0);
		c.db.recordDevice({ platform: "ios", id: "U2", name: "warden-iphone-17-2" }, NOW - 60_000);
		c.db.recordDevice({ platform: "ios", id: "U3", name: "warden-iphone-17-3" }, 0);
		c.db.insertLease(
			{
				resource: { kind: "device", platform: "ios", id: "U1", name: "warden-iphone-17-1" },
				owner: agent,
				ttlMs: 60_000,
			},
			NOW
		);
		return { c, calls, idle };
	}

	test("idle devices go down several at a time, never more than the bound, each once", async () => {
		const { c, calls, idle } = crowd();
		const slow = slowShutdowns(c.exec, 15);
		c.exec = slow.exec;
		expect(await gcCommand.run(c)).toBe(0);
		expect(slow.peak()).toBeGreaterThan(1);
		expect(slow.peak()).toBeLessThanOrEqual(4);
		const wanted = idle.map((s) => s.udid).sort();
		expect([...slow.order].sort()).toEqual(wanted);
		const out = JSON.parse(c.stdout.join("\n"));
		expect(out.shutdown.map((d: { id: string }) => d.id)).toEqual(idle.map((s) => s.udid).sort());
		expect(calls.filter((x) => x[2] === "shutdown").map((x) => x[3])).toHaveLength(idle.length);
	});

	test("only warden's own idle, booted, unleased devices are shut down: foreign, leased, recent and already-down ones are untouched", async () => {
		const { c, idle } = crowd();
		const slow = slowShutdowns(c.exec, 5);
		c.exec = slow.exec;
		expect(await gcCommand.run(c)).toBe(0);
		const shut = new Set(slow.order);
		expect(shut).toEqual(new Set(idle.map((s) => s.udid)));
		for (const left of ["FOREIGN", "U1", "U2", "U3"]) expect(shut.has(left)).toBe(false);
	});

	test("one shutdown that fails is a note; the others still go down", async () => {
		const { c, idle } = crowd([["xcrun simctl shutdown U13", { exitCode: 1, stderr: "Unable to shutdown device" }]]);
		const slow = slowShutdowns(c.exec, 5);
		c.exec = slow.exec;
		expect(await gcCommand.run(c)).toBe(0);
		const out = JSON.parse(c.stdout.join("\n"));
		expect(out.shutdown.map((d: { id: string }) => d.id)).toEqual(
			idle
				.map((s) => s.udid)
				.filter((id) => id !== "U13")
				.sort()
		);
		expect(out.notes.join("\n")).toContain("shutdown U13 failed");
	});
});

describe("warden gc: a device claimed while the pass runs (16-1, 12-2)", () => {
	const U1 = { kind: "device", platform: "ios", id: "U1", name: "warden-iphone-17-1" } as const;

	/** one idle booted warden sim; `during` runs when gc lists devices, i.e. after gc read its leases */
	function racing(during: (c: TestContext) => void, calls: string[][] = []): TestContext {
		const base = fakeSimctl([wardenSim(1, "Booted"), wardenSim(5, "Booted")], calls);
		const c = testContext(["--json"], {
			now: () => NOW,
			exec: async (cmd, opts) => {
				if (cmd.join(" ").startsWith("xcrun simctl list devices")) during(c);
				return base(cmd, opts);
			},
		});
		ctx = c;
		c.db.recordDevice({ platform: "ios", id: "U1", name: "warden-iphone-17-1" }, 0);
		c.db.recordDevice({ platform: "ios", id: "U5", name: "warden-iphone-17-5" }, 0);
		return c;
	}

	const shutdowns = (calls: string[][]) => calls.filter((x) => x[2] === "shutdown").map((x) => x[3]);

	test("a device leased after gc read its leases is not shut down", async () => {
		const calls: string[][] = [];
		const c = racing((t) => {
			if (!t.db.findLeaseByResource(U1)) t.db.insertLease({ resource: U1, owner: agent, ttlMs: 60_000 }, NOW);
		}, calls);
		expect(await gcCommand.run(c)).toBe(0);
		expect(shutdowns(calls)).toEqual(["U5"]);
		expect(JSON.parse(c.stdout.join("\n")).shutdown.map((d: { id: string }) => d.id)).toEqual(["U5"]);
		expect(c.db.findLeaseByResource(U1)?.owner).toEqual(agent);
	});

	test("a device used again (last_used_at moved) since the plan is not shut down", async () => {
		const calls: string[][] = [];
		const c = racing((t) => t.db.touchDevice("ios", "U1", NOW), calls);
		expect(await gcCommand.run(c)).toBe(0);
		expect(shutdowns(calls)).toEqual(["U5"]);
	});

	test("gc holds a gc-shutdown lease on the device while shutting it down, and drops it after", async () => {
		const held: Array<string | undefined> = [];
		const base = fakeSimctl([wardenSim(1, "Booted")]);
		const c = testContext(["--json"], {
			now: () => NOW,
			exec: async (cmd, opts) => {
				if (cmd[2] === "shutdown") held.push(c.db.findLeaseByResource(U1)?.label);
				return base(cmd, opts);
			},
		});
		ctx = c;
		c.db.recordDevice({ platform: "ios", id: "U1", name: "warden-iphone-17-1" }, 0);
		expect(await gcCommand.run(c)).toBe(0);
		expect(held).toEqual(["gc-shutdown"]);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("the gc-shutdown lease is dropped when the shutdown fails too", async () => {
		const c = testContext(["--json"], {
			now: () => NOW,
			exec: fakeSimctl(
				[wardenSim(1, "Booted")],
				[],
				[["xcrun simctl shutdown U1", { exitCode: 1, stderr: "Unable to shutdown device" }]]
			),
		});
		ctx = c;
		c.db.recordDevice({ platform: "ios", id: "U1", name: "warden-iphone-17-1" }, 0);
		expect(await gcCommand.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n")).notes.join("\n")).toContain("shutdown U1 failed");
		expect(c.db.listLeases()).toEqual([]);
	});

	describe("dev session dirs", () => {
		const DAY = 24 * 60 * 60_000;
		const NOW_DEV = 40 * DAY;

		function devDir(c: TestContext, leaseId: string, ageMs: number, files = ["warden.log"]): string {
			const dir = join(c.env.WARDEN_HOME ?? "", "dev", leaseId);
			mkdirSync(join(dir, "shots"), { recursive: true });
			for (const file of files) {
				const path = join(dir, file);
				writeFileSync(path, "x");
				const at = (NOW_DEV - ageMs) / 1000;
				utimesSync(path, at, at);
			}
			return dir;
		}

		function run(): TestContext {
			ctx = testContext(["--json"], { now: () => NOW_DEV, exec: fakeExec([]) });
			return ctx;
		}

		test("removes dirs of leases that are gone and idle for over 24 h, keeps the rest", async () => {
			const c = run();
			const live = c.db.insertLease({ resource: { kind: "port", port: 9 }, owner: agent, ttlMs: DAY * 365 }, NOW_DEV);
			const old = devDir(c, "gone-old", 25 * 60 * 60_000);
			const fresh = devDir(c, "gone-fresh", 23 * 60 * 60_000);
			const held = devDir(c, "held", 30 * 60 * 60_000);
			const mixed = devDir(c, "gone-mixed", 48 * 60 * 60_000, ["warden.log", "shots/new.png"]);
			const touched = join(mixed, "shots", "new.png");
			const recent = (NOW_DEV - 60_000) / 1000;
			utimesSync(touched, recent, recent);
			const liveDir = devDir(c, live.id, 30 * 60 * 60_000);
			expect(await gcCommand.run(c)).toBe(0);
			expect(existsSync(old)).toBe(false);
			expect(existsSync(fresh)).toBe(true);
			expect(existsSync(held)).toBe(false);
			expect(existsSync(mixed)).toBe(true);
			expect(existsSync(liveDir)).toBe(true);
			expect(JSON.parse(c.stdout.join("\n")).notes).toContain("removed 2 old dev session dirs");
		});

		test("nothing to sweep adds no note", async () => {
			const c = run();
			expect(await gcCommand.run(c)).toBe(0);
			expect(JSON.parse(c.stdout.join("\n")).notes).toEqual([]);
		});
	});
});
