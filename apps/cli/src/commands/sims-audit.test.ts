import { afterEach, describe, expect, test } from "bun:test";
import { type FixtureSim, simctlDevicesJson } from "@delacour/warden-core/providers/ios.fixture";
import { fakeExec, scriptedUi, type TestContext, testContext } from "../testing";
import { simsCommand } from "./sims";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const GB = 1024 ** 3;

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const SIMS: FixtureSim[] = [
	{ udid: "OLD", name: "warden-iphone-17-1", state: "Shutdown", dataPathSize: 3 * GB },
	{ udid: "NEW", name: "warden-iphone-17-2", state: "Shutdown", dataPathSize: 2 * GB },
	{ udid: "FOR", name: "My iPhone", state: "Shutdown", dataPathSize: GB, isAvailable: false },
];

const RT = "com.apple.CoreSimulator.SimRuntime.";
const RUNTIMES_JSON = JSON.stringify({
	R265: {
		identifier: "R265",
		runtimeIdentifier: `${RT}iOS-26-5`,
		build: "23F77",
		version: "26.5",
		sizeBytes: 8 * GB,
		deletable: true,
		state: "Ready",
	},
	R261: {
		identifier: "R261",
		runtimeIdentifier: `${RT}iOS-26-1`,
		build: "23B86",
		version: "26.1",
		sizeBytes: 7 * GB,
		deletable: true,
		state: "Ready",
	},
});

function setup(argv: string[], opts: { interactive?: boolean; confirm?: boolean[] } = {}): TestContext {
	const calls: string[][] = [];
	ctx = testContext(argv, { now: () => NOW, ui: scriptedUi(opts) });
	ctx.exec = fakeExec(
		[
			["xcrun simctl list devices -j", { stdout: simctlDevicesJson({ "iOS-26-5": SIMS }) }],
			["xcrun simctl shutdown", {}],
			["xcrun simctl delete", {}],
			["xcrun simctl runtime list -j", { stdout: RUNTIMES_JSON }],
		],
		calls
	);
	ctx.db.recordDevice({ platform: "ios", id: "OLD", name: "warden-iphone-17-1" }, NOW - 30 * DAY);
	ctx.db.recordDevice({ platform: "ios", id: "NEW", name: "warden-iphone-17-2" }, NOW - DAY);
	Object.assign(ctx, { calls });
	return ctx;
}

const callsOf = (c: TestContext) => (c as TestContext & { calls: string[][] }).calls.map((x) => x.join(" "));
const deletes = (c: TestContext) => callsOf(c).filter((l) => l.startsWith("xcrun simctl delete"));

describe("warden sims audit", () => {
	test("--json reports every sim, verdicts and totals", async () => {
		const c = setup(["audit", "--json"]);
		expect(await simsCommand.run(c)).toBe(0);
		const report = JSON.parse(c.stdout.join("\n"));
		expect(report.entries.map((e: { udid: string; verdict: unknown }) => [e.udid, e.verdict])).toEqual([
			["OLD", { kind: "delete", reason: "idle" }],
			["NEW", { kind: "keep", reason: "recent" }],
			["FOR", { kind: "foreign", hint: "unavailable-runtime" }],
		]);
		expect(report.totalBytes).toBe(6 * GB);
		expect(report.reclaimableBytes).toBe(3 * GB);
		expect(report.foreignReclaimableBytes).toBe(GB);
		expect(deletes(c)).toEqual([]);
	});

	test("--json includes the runtime audit", async () => {
		const c = setup(["--json"]);
		expect(await simsCommand.run(c)).toBe(0);
		const { runtimes } = JSON.parse(c.stdout.join("\n"));
		expect(
			runtimes.entries.map((r: { runtime: string; sims: number; verdict: unknown }) => [r.runtime, r.sims, r.verdict])
		).toEqual([
			["iOS-26-5", 3, { kind: "in-use" }],
			["iOS-26-1", 0, { kind: "unused" }],
		]);
		expect(runtimes.unusedBytes).toBe(7 * GB);
	});

	test("runtime table and delete hint; a failing runtime list is only a note", async () => {
		const c = setup([]);
		expect(await simsCommand.run(c)).toBe(0);
		const out = c.stdout.join("\n");
		expect(out).toContain("RUNTIME");
		expect(out).toContain("xcrun simctl runtime delete <identifier>");
		const old = setup(["--json"]);
		old.exec = fakeExec([["xcrun simctl list devices -j", { stdout: simctlDevicesJson({ "iOS-26-5": SIMS }) }]]);
		expect(await simsCommand.run(old)).toBe(0);
		const report = JSON.parse(old.stdout.join("\n"));
		expect(report.runtimes).toBeNull();
		expect(report.runtimesError).toContain("runtime list");
	});

	test("table is the default subcommand, with a footer and a foreign hint", async () => {
		const c = setup([]);
		expect(await simsCommand.run(c)).toBe(0);
		const out = c.stdout.join("\n");
		expect(out).toContain("SIZE");
		expect(out).toContain("warden-iphone-17-1");
		expect(out).toContain("6.0G");
		expect(out).toContain("warden sims prune");
		expect(out).toContain("warden sims delete");
	});

	test("--max-size warns when over budget", async () => {
		const c = setup(["--max-size", "512M"]);
		expect(await simsCommand.run(c)).toBe(0);
		expect(c.stdout.join("\n")).toContain("over budget");
	});

	test("--owner foreign filters entries", async () => {
		const c = setup(["audit", "--owner", "foreign", "--json"]);
		expect(await simsCommand.run(c)).toBe(0);
		const report = JSON.parse(c.stdout.join("\n"));
		expect(report.entries.map((e: { udid: string }) => e.udid)).toEqual(["FOR"]);
	});

	test("bad --idle / --stale fails", async () => {
		const c = setup(["audit", "--idle", "soon"]);
		expect(await simsCommand.run(c)).toBe(1);
		const s = setup(["audit", "--stale", "soon"]);
		expect(await simsCommand.run(s)).toBe(1);
		expect(s.stderr.join("\n")).toContain("--stale");
	});

	test("--stale moves the foreign hint threshold, like `sims delete`", async () => {
		const foreign = (stale: string) => {
			const c = setup(["audit", "--json", "--stale", stale]);
			c.exec = fakeExec([
				[
					"xcrun simctl list devices -j",
					{
						stdout: simctlDevicesJson({
							"iOS-26-5": [
								{ udid: "F", name: "x", state: "Shutdown", lastBootedAt: new Date(NOW - 40 * DAY).toISOString() },
							],
						}),
					},
				],
			]);
			return c;
		};
		const c30 = foreign("30d");
		expect(await simsCommand.run(c30)).toBe(0);
		expect(JSON.parse(c30.stdout.join("\n")).entries[0].verdict).toEqual({ kind: "foreign", hint: "stale" });
		const c60 = foreign("60d");
		expect(await simsCommand.run(c60)).toBe(0);
		expect(JSON.parse(c60.stdout.join("\n")).entries[0].verdict).toEqual({ kind: "foreign" });
	});

	test("VERDICT shows the shared reason text", async () => {
		const c = setup([]);
		expect(await simsCommand.run(c)).toBe(0);
		const out = c.stdout.join("\n");
		expect(out).toContain("warden sim unused 30d");
		expect(out).toContain("runtime removed");
	});
});

describe("warden sims prune", () => {
	test("--dry-run deletes nothing", async () => {
		const c = setup(["prune", "--dry-run", "--json"]);
		expect(await simsCommand.run(c)).toBe(0);
		const result = JSON.parse(c.stdout.join("\n"));
		expect(result.dryRun).toBe(true);
		expect(result.removed.map((e: { udid: string }) => e.udid)).toEqual(["OLD"]);
		expect(deletes(c)).toEqual([]);
	});

	test("non-interactive without --yes refuses", async () => {
		const c = setup(["prune"]);
		expect(await simsCommand.run(c)).toBe(1);
		expect(deletes(c)).toEqual([]);
	});

	test("interactive decline aborts", async () => {
		const c = setup(["prune"], { interactive: true, confirm: [false] });
		expect(await simsCommand.run(c)).toBe(1);
		expect(deletes(c)).toEqual([]);
	});

	test("--yes deletes only warden sims and forgets them", async () => {
		const c = setup(["prune", "--yes"]);
		expect(await simsCommand.run(c)).toBe(0);
		expect(deletes(c)).toEqual(["xcrun simctl delete OLD"]);
		expect(c.db.listDevices("ios").map((r) => r.id)).toEqual(["NEW"]);
		expect(c.stdout.join("\n")).toContain("freed 3.0G");
	});

	test("--max-size also removes least-recently-used warden sims", async () => {
		const c = setup(["prune", "--yes", "--max-size", "1G"]);
		expect(await simsCommand.run(c)).toBe(0);
		expect(deletes(c)).toEqual(["xcrun simctl delete OLD", "xcrun simctl delete NEW"]);
	});
});
