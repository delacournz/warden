import { afterEach, describe, expect, test } from "bun:test";
import type { Owner } from "@delacour/warden-core/types";
import { fakeSimctl, OWNER_ENV } from "../simctl.testing";
import { scriptedUi, type TestContext, testContext } from "../testing";
import { simsCommand } from "./sims";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const other: Owner = { kind: "agent", sessionId: "s2", cwd: "/", repo: "warden", worktree: "cowrie@main" };

const SIMS = [
	{ udid: "U1", name: "warden-iphone-17-1", state: "Booted" as const },
	{ udid: "U2", name: "iPhone 17 Pro", state: "Shutdown" as const },
	{ udid: "U3", name: "warden-iphone-17-3", state: "Shutdown" as const },
	{ udid: "G1", name: "warden-golden-iphone-17-abc", state: "Shutdown" as const },
];

type SetupOpts = {
	interactive?: boolean;
	multiselect?: Array<string[] | undefined>;
	confirm?: Array<boolean | undefined>;
};

function setup(argv: string[], opts: SetupOpts = {}): { c: TestContext; calls: string[][] } {
	const calls: string[][] = [];
	const c = testContext(["delete", ...argv], {
		exec: fakeSimctl(SIMS, calls, [["xcrun simctl delete", {}]]),
		ui: scriptedUi({
			interactive: opts.interactive ?? false,
			...(opts.multiselect ? { multiselect: opts.multiselect } : {}),
			...(opts.confirm ? { confirm: opts.confirm } : {}),
		}),
	});
	c.env = { ...c.env, ...OWNER_ENV };
	c.db.recordDevice({ platform: "ios", id: "U3", name: "warden-iphone-17-3", profile: "iphone-17" }, 0);
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
});
