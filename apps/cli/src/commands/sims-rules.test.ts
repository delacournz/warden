import { afterEach, describe, expect, test } from "bun:test";
import { MIXED_SIMS_RECORDS, mixedSims, simctlDevicesJson } from "@delacour/warden-core/providers/ios.fixture";
import type { SimEntry, SimReason } from "@delacour/warden-core/sims/rules";
import { OWNER_ENV } from "../simctl.testing";
import { fakeExec, scriptedUi, type TestContext, testContext } from "../testing";
import { simsCommand } from "./sims";

const DAY = 86_400_000;
const NOW = 100 * DAY;

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

function setup(argv: string[], ui: Parameters<typeof scriptedUi>[0] = {}): TestContext {
	const c = testContext(argv, {
		now: () => NOW,
		exec: fakeExec([
			["xcrun simctl list devices -j", { stdout: simctlDevicesJson(mixedSims(NOW)) }],
			["xcrun simctl runtime list -j", { stdout: "{}" }],
		]),
		ui: scriptedUi(ui),
	});
	c.env = { ...c.env, ...OWNER_ENV };
	for (const [id, days] of Object.entries(MIXED_SIMS_RECORDS))
		c.db.recordDevice({ platform: "ios", id, name: id }, NOW - days * DAY);
	c.db.insertLease(
		{
			resource: { kind: "device", platform: "ios", id: "W-LEASED", name: "warden-iphone-17-5" },
			owner: { kind: "agent", sessionId: "other", cwd: "/" },
			ttlMs: 60_000,
		},
		NOW
	);
	ctx = c;
	return c;
}

async function json<T>(argv: string[]): Promise<T> {
	const c = setup(argv);
	expect(await simsCommand.run(c)).toBe(0);
	const out: T = JSON.parse(c.stdout.join("\n"));
	c.cleanup();
	ctx = undefined;
	return out;
}

type Reasons = Record<string, SimReason[]>;

describe("audit, prune and delete agree on one machine", () => {
	test("same reasons per sim; prune ⊂ suggested; the menu ticks exactly the suggestions", async () => {
		const audit = await json<{ entries: SimEntry[] }>(["audit", "--json"]);
		const prune = await json<{ removed: SimEntry[] }>(["prune", "--dry-run", "--json"]);
		const del = await json<{ wouldDelete: Array<{ id: string; reasons: SimReason[] }> }>([
			"delete",
			"--suggested",
			"--dry-run",
			"--json",
		]);

		const auditDeletes = audit.entries.filter((e) => e.verdict.kind === "delete");
		const auditHinted = audit.entries.filter(
			(e) => e.verdict.kind === "delete" || (e.verdict.kind === "foreign" && e.verdict.hint !== undefined)
		);
		const byId = (rows: Array<{ id: string; reasons: SimReason[] }>): Reasons =>
			Object.fromEntries(rows.map((r) => [r.id, r.reasons]));

		expect(prune.removed.map((e) => e.udid).sort()).toEqual(auditDeletes.map((e) => e.udid).sort());
		expect(byId(del.wouldDelete)).toEqual(byId(auditHinted.map((e) => ({ id: e.udid, reasons: e.reasons }))));
		expect(byId(del.wouldDelete)).toEqual({
			"F-GONE": [{ kind: "unavailable-runtime" }],
			"F-OLD": [{ kind: "old-runtime", newest: "iOS-26-5" }],
			"W-IDLE": [{ kind: "idle", sinceMs: 20 * DAY }],
			"W-ORPHAN": [{ kind: "orphan" }],
			"F-STALE": [{ kind: "stale", sinceMs: 45 * DAY }],
			"F-DUP-A": [{ kind: "duplicate", of: { udid: "F-DUP-B", name: "iPhone 17" } }],
		});

		const c = setup(["delete"], { interactive: true, multiselect: [[]] });
		expect(await simsCommand.run(c)).toBe(0);
		const menu = (c.ui as ReturnType<typeof scriptedUi>).events[0] ?? "";
		const offered = (/\[(.*)\]$/.exec(menu)?.[1] ?? "").split(" ");
		const marked = (mark: string) =>
			offered
				.filter((o) => o.startsWith(mark))
				.map((o) => o.slice(1))
				.sort();
		expect(marked("*")).toEqual(Object.keys(byId(del.wouldDelete)).sort());
		const disabled = marked("-");
		expect(disabled).toEqual(["G-GOLD", "W-LEASED"]);
	});

	test("the audit VERDICT column and the delete menu read the same reason text", async () => {
		const c = setup(["audit"]);
		expect(await simsCommand.run(c)).toBe(0);
		const table = c.stdout.join("\n");
		for (const text of [
			"runtime removed",
			"warden sim unused 20d",
			"warden-named, no warden record",
			"not booted in 45d",
			"older runtime (iOS-26-5 installed)",
			"duplicate of iPhone 17",
		])
			expect(table).toContain(text);
	});
});
