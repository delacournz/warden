import { afterEach, describe, expect, test } from "bun:test";
import { type FixtureSim, simctlDevicesJson } from "@delacour/warden-core/providers/ios.fixture";
import type { Owner } from "@delacour/warden-core/types";
import { fakeSimctl, OWNER_ENV } from "../simctl.testing";
import { scriptedUi, type TestContext, testContext } from "../testing";
import { describeReasons, simsCommand } from "./sims";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const other: Owner = { kind: "agent", sessionId: "s2", cwd: "/", repo: "warden", worktree: "cowrie@main" };

const DAY = 86_400_000;
const NOW = 100 * DAY;
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

const SIMS = [
	{ udid: "U1", name: "warden-iphone-17-1", state: "Booted" as const },
	{ udid: "U2", name: "iPhone 17 Pro", state: "Shutdown" as const },
	{ udid: "U3", name: "warden-iphone-17-3", state: "Shutdown" as const },
	{ udid: "G1", name: "warden-golden-iphone-17-abc", state: "Shutdown" as const },
];

type SetupOpts = {
	/** runtime suffix → sims (default: SIMS on iOS-26-5) */
	sims?: Record<string, FixtureSim[]>;
	interactive?: boolean;
	multiselect?: Array<string[] | undefined>;
	confirm?: Array<boolean | undefined>;
};

function setup(argv: string[], opts: SetupOpts = {}): { c: TestContext; calls: string[][] } {
	const calls: string[][] = [];
	const c = testContext(["delete", ...argv], {
		now: () => NOW,
		exec: fakeSimctl(SIMS, calls, [
			["xcrun simctl list devices -j", { stdout: simctlDevicesJson(opts.sims ?? { "iOS-26-5": SIMS }) }],
			["xcrun simctl delete", {}],
		]),
		ui: scriptedUi({
			interactive: opts.interactive ?? false,
			...(opts.multiselect ? { multiselect: opts.multiselect } : {}),
			...(opts.confirm ? { confirm: opts.confirm } : {}),
		}),
	});
	c.env = { ...c.env, ...OWNER_ENV };
	c.db.recordDevice({ platform: "ios", id: "U3", name: "warden-iphone-17-3", profile: "iphone-17" }, NOW);
	c.db.insertLease(
		{
			resource: { kind: "device", platform: "ios", id: "U1", name: "warden-iphone-17-1" },
			owner: other,
			ttlMs: 60_000,
		},
		c.now()
	);
	ctx = c;
	return { c, calls };
}

const deletes = (calls: string[][]) =>
	calls.filter((cmd) => cmd[2] === "delete" || cmd[2] === "shutdown").map((cmd) => cmd.join(" "));

const events = (c: TestContext) => (c.ui as ReturnType<typeof scriptedUi>).events;

describe("warden sims delete", () => {
	test("menu offers every sim; leased + golden ones are shown but disabled", async () => {
		const { c } = setup([], { interactive: true, multiselect: [[]] });
		expect(await simsCommand.run(c)).toBe(0);
		expect(events(c)[0]).toBe("multiselect: Select simulators to delete [-U1 +U2 -G1 +U3]");
	});

	test("deletes the selected sims after confirming and forgets warden's record", async () => {
		const { c, calls } = setup([], { interactive: true, multiselect: [["U2", "U3"]], confirm: [true] });
		expect(await simsCommand.run(c)).toBe(0);
		expect(events(c)).toContain("confirm: Delete 2 simulator(s)? This can't be undone.");
		expect(deletes(calls)).toEqual([
			"xcrun simctl shutdown U2",
			"xcrun simctl delete U2",
			"xcrun simctl shutdown U3",
			"xcrun simctl delete U3",
		]);
		expect(c.db.listDevices("ios")).toEqual([]);
		expect(c.db.listLeases().map((l) => l.resource.kind === "device" && l.resource.id)).toEqual(["U1"]);
	});

	test("declining the confirm deletes nothing", async () => {
		const { c, calls } = setup([], { interactive: true, multiselect: [["U2"]], confirm: [false] });
		expect(await simsCommand.run(c)).toBe(1);
		expect(deletes(calls)).toEqual([]);
		expect(events(c)).toContain("cancelled: Aborted.");
	});

	test("cancelling the menu deletes nothing", async () => {
		const { c, calls } = setup([], { interactive: true, multiselect: [undefined] });
		expect(await simsCommand.run(c)).toBe(1);
		expect(deletes(calls)).toEqual([]);
	});

	test("no terminal and no udids → usage error", async () => {
		const { c } = setup([]);
		expect(await simsCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("pass udids");
	});

	test("udids + --yes deletes without prompting (--json)", async () => {
		const { c, calls } = setup(["U2", "--yes", "--json"]);
		expect(await simsCommand.run(c)).toBe(0);
		expect(deletes(calls)).toEqual(["xcrun simctl shutdown U2", "xcrun simctl delete U2"]);
		expect(JSON.parse(c.stdout.join("\n"))).toEqual({
			deleted: [{ id: "U2", name: "iPhone 17 Pro" }],
			failed: [],
		});
	});

	test("udids without --yes off a terminal → refuses", async () => {
		const { c, calls } = setup(["U2"]);
		expect(await simsCommand.run(c)).toBe(1);
		expect(deletes(calls)).toEqual([]);
		expect(c.stderr.join("\n")).toContain("--yes");
	});

	test("a leased, golden or unknown udid is refused before anything is deleted", async () => {
		for (const [id, reason] of [
			["U1", "leased by"],
			["G1", "warden golden prune"],
			["NOPE", "no simulator"],
		] as const) {
			const { c, calls } = setup(["U2", id, "--yes"]);
			expect(await simsCommand.run(c)).toBe(1);
			expect(deletes(calls)).toEqual([]);
			expect(c.stderr.join("\n")).toContain(reason);
			c.cleanup();
			ctx = undefined;
		}
	});

	test("a sim leased after the menu (claim race) is skipped, not deleted", async () => {
		const { c, calls } = setup([], { interactive: true, multiselect: [["U2"]], confirm: [true] });
		const ui = c.ui;
		c.ui = {
			...ui,
			confirm: async (message, initial) => {
				c.db.insertLease(
					{
						resource: { kind: "device", platform: "ios", id: "U2", name: "iPhone 17 Pro" },
						owner: other,
						ttlMs: 60_000,
					},
					c.now()
				);
				return ui.confirm(message, initial);
			},
		};
		expect(await simsCommand.run(c)).toBe(1);
		expect(deletes(calls)).toEqual([]);
		expect(c.stderr.join("\n")).toContain("U2");
	});

	describe("suggestions", () => {
		const SUGGEST = {
			"iOS-17-0": [{ udid: "GONE", name: "iPhone 15", state: "Shutdown" as const, isAvailable: false }],
			"iOS-26-5": [
				{ udid: "FRESH", name: "iPhone 17", state: "Shutdown" as const, lastBootedAt: daysAgo(1) },
				{ udid: "STALE", name: "iPhone Air", state: "Shutdown" as const, lastBootedAt: daysAgo(45) },
				{ udid: "U1", name: "warden-iphone-17-1", state: "Booted" as const, lastBootedAt: daysAgo(90) },
			],
		};

		test("suggested sims come first and start ticked; a leased one stays disabled", async () => {
			const { c } = setup([], { sims: SUGGEST, interactive: true, multiselect: [[]] });
			expect(await simsCommand.run(c)).toBe(0);
			expect(events(c)[0]).toBe("multiselect: Select simulators to delete [*GONE *STALE -U1 +FRESH]");
		});

		test("an unavailable sim is deleted without a shutdown", async () => {
			const { c, calls } = setup([], { sims: SUGGEST, interactive: true, multiselect: [["GONE"]], confirm: [true] });
			expect(await simsCommand.run(c)).toBe(0);
			expect(deletes(calls)).toEqual(["xcrun simctl delete GONE"]);
		});

		test("--suggested -y deletes just the (unleased) suggestions without the menu", async () => {
			const { c, calls } = setup(["--suggested", "-y"], { sims: SUGGEST });
			expect(await simsCommand.run(c)).toBe(0);
			expect(deletes(calls)).toEqual([
				"xcrun simctl delete GONE",
				"xcrun simctl shutdown STALE",
				"xcrun simctl delete STALE",
			]);
		});

		test("--stale moves the threshold", async () => {
			const { c, calls } = setup(["--suggested", "-y", "--stale", "60d"], { sims: SUGGEST });
			expect(await simsCommand.run(c)).toBe(0);
			expect(deletes(calls)).toEqual(["xcrun simctl delete GONE"]);
		});

		test("--suggested with nothing to suggest is a no-op", async () => {
			const { c, calls } = setup(["--suggested", "-y"]);
			expect(await simsCommand.run(c)).toBe(0);
			expect(deletes(calls)).toEqual([]);
			expect(c.stderr.join("\n")).toContain("no suggested simulators");
		});

		test("--suggested with udids, or a bad --stale, is a usage error", async () => {
			for (const argv of [
				["U2", "--suggested", "-y"],
				["--suggested", "-y", "--stale", "soon"],
			]) {
				const { c, calls } = setup(argv);
				expect(await simsCommand.run(c)).toBe(1);
				expect(deletes(calls)).toEqual([]);
				c.cleanup();
				ctx = undefined;
			}
		});

		test("--suggested --dry-run lists what would go (with reasons) and deletes nothing, off a terminal too", async () => {
			const { c, calls } = setup(["--suggested", "--dry-run", "--json"], { sims: SUGGEST });
			expect(await simsCommand.run(c)).toBe(0);
			expect(deletes(calls)).toEqual([]);
			expect(JSON.parse(c.stdout.join("\n"))).toEqual({
				dryRun: true,
				wouldDelete: [
					{ id: "GONE", name: "iPhone 15", reasons: [{ kind: "unavailable" }] },
					{ id: "STALE", name: "iPhone Air", reasons: [{ kind: "stale", sinceMs: 45 * DAY }] },
				],
			});
		});

		test("describeReasons reads like a hint", () => {
			expect(
				describeReasons([
					{ kind: "unavailable" },
					{ kind: "stale", sinceMs: 45 * DAY },
					{ kind: "old-runtime", newest: "iOS-26-5" },
					{ kind: "duplicate", of: { id: "U2", name: "iPhone 17" } },
					{ kind: "idle-pool", sinceMs: 9 * DAY },
				])
			).toBe(
				"runtime removed · not booted in 45d · older runtime (iOS-26-5 installed) · duplicate of iPhone 17 · warden sim unused 9d"
			);
		});
	});
});
