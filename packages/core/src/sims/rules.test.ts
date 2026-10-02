import { describe, expect, test } from "bun:test";
import type { DeviceRecord } from "../store";
import type { Lease, Owner } from "../types";
import type { SimctlSim } from "./list";
import {
	canDelete,
	canPrune,
	compareRuntimes,
	describeReasons,
	isSuggested,
	judgeSims,
	type RulesInput,
	type SimEntry,
} from "./rules";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const GB = 1024 ** 3;
const RT = "com.apple.CoreSimulator.SimRuntime.";
const IPHONE_17 = "com.apple.CoreSimulator.SimDeviceType.iPhone-17";
const OWNER: Owner = { kind: "agent", sessionId: "s", cwd: "/" };

function sim(udid: string, name: string, extra: Partial<SimctlSim> = {}): SimctlSim {
	return {
		udid,
		name,
		state: "Shutdown",
		isAvailable: true,
		runtimeId: `${RT}iOS-26-5`,
		deviceTypeIdentifier: IPHONE_17,
		dataPathSize: GB,
		...extra,
	};
}

const record = (id: string, lastUsedAt: number): DeviceRecord => ({
	platform: "ios",
	id,
	name: `warden-iphone-17-${id}`,
	createdAt: 0,
	lastUsedAt,
});

function lease(id: string, heartbeatAt = NOW): Lease {
	return {
		id: `L-${id}`,
		resource: { kind: "device", platform: "ios", id, name: id },
		owner: OWNER,
		acquiredAt: heartbeatAt,
		heartbeatAt,
		ttlMs: 60_000,
	};
}

function input(over: Partial<RulesInput>): RulesInput {
	return {
		sims: [],
		records: [],
		leases: [],
		now: NOW,
		pidAlive: () => false,
		idleMs: 7 * DAY,
		staleMs: 30 * DAY,
		...over,
	};
}

const judge = (over: Partial<RulesInput>) => Object.fromEntries(judgeSims(input(over)).map((e) => [e.udid, e]));
const entry = (byId: Record<string, SimEntry>, id: string): SimEntry => {
	const e = byId[id];
	if (!e) throw new Error(`no ${id}`);
	return e;
};

describe("judgeSims: owner", () => {
	test("store record / warden- name = warden, warden-golden- = golden, else foreign", () => {
		const j = judge({
			sims: [
				sim("A", "warden-iphone-17-1"),
				sim("B", "my phone"),
				sim("C", "warden-golden-iphone-17-0123456789"),
				sim("D", "renamed by user"),
			],
			records: [record("A", NOW), record("D", NOW)],
		});
		expect(["A", "B", "C", "D"].map((id) => entry(j, id).owner)).toEqual(["warden", "foreign", "golden", "warden"]);
	});
});

describe("judgeSims: blockers", () => {
	test("leased (live or stale), booted and golden block; a stale lease says so", () => {
		const j = judge({
			sims: [
				sim("L", "warden-iphone-17-1"),
				sim("S", "warden-iphone-17-2"),
				sim("B", "warden-iphone-17-3", { state: "Booted" }),
				sim("G", "warden-golden-iphone-17-0123456789"),
			],
			records: [record("L", 0), record("S", 0), record("B", 0)],
			leases: [lease("L"), lease("S", 0)],
		});
		expect(entry(j, "L").blockers).toEqual([{ kind: "leased", owner: OWNER, stale: false }]);
		expect(entry(j, "S").blockers).toEqual([{ kind: "leased", owner: OWNER, stale: true }]);
		expect(entry(j, "B").blockers).toEqual([{ kind: "booted" }]);
		expect(entry(j, "G").blockers).toEqual([{ kind: "golden" }]);
		expect(["L", "S", "B", "G"].map((id) => entry(j, id).verdict)).toEqual([
			{ kind: "keep", reason: "leased" },
			{ kind: "keep", reason: "leased" },
			{ kind: "keep", reason: "booted" },
			{ kind: "keep", reason: "golden" },
		]);
	});
});

describe("judgeSims: warden reasons", () => {
	test("unavailable runtime, orphan (no store record) and idle are deletable; recent kept", () => {
		const j = judge({
			sims: [
				sim("A", "warden-iphone-17-1", { isAvailable: false }),
				sim("B", "warden-iphone-17-2"),
				sim("C", "warden-iphone-17-3"),
				sim("D", "warden-iphone-17-4"),
			],
			records: [record("A", NOW), record("C", NOW - 8 * DAY), record("D", NOW - DAY)],
		});
		expect(entry(j, "A").reasons).toEqual([{ kind: "unavailable-runtime" }]);
		expect(entry(j, "B").reasons).toEqual([{ kind: "orphan" }]);
		expect(entry(j, "C").reasons).toEqual([{ kind: "idle", sinceMs: 8 * DAY }]);
		expect(entry(j, "D").reasons).toEqual([]);
		expect(entry(j, "A").verdict).toEqual({ kind: "delete", reason: "unavailable-runtime" });
		expect(entry(j, "B").verdict).toEqual({ kind: "delete", reason: "orphan" });
		expect(entry(j, "C").verdict).toEqual({ kind: "delete", reason: "idle" });
		expect(entry(j, "D").verdict).toEqual({ kind: "keep", reason: "recent" });
	});

	test("last use is the latest of warden's lastUsedAt and simctl's lastBootedAt", () => {
		const j = judge({
			sims: [sim("A", "warden-iphone-17-1", { lastBootedAt: NOW - DAY })],
			records: [record("A", NOW - 30 * DAY)],
		});
		expect(entry(j, "A").lastUsedAt).toBe(NOW - DAY);
		expect(entry(j, "A").verdict).toEqual({ kind: "keep", reason: "recent" });
	});

	test("older runtimes and same-name duplicates are foreign-only reasons (warden manages its pool)", () => {
		const j = judge({
			sims: [sim("NEW", "iPhone 17"), sim("W", "warden-iphone-17-1", { runtimeId: `${RT}iOS-18-6` })],
			records: [record("W", NOW)],
		});
		expect(entry(j, "W").reasons).toEqual([]);
	});

	test("--max-size: least-recently-used recent warden sims get `budget` until under it", () => {
		const j = judge({
			sims: [
				sim("A", "warden-iphone-17-1"),
				sim("B", "warden-iphone-17-2"),
				sim("C", "warden-iphone-17-3"),
				sim("L", "warden-iphone-17-4"),
				sim("F", "foreign"),
			],
			records: [record("A", NOW - 3 * DAY), record("B", NOW - 2 * DAY), record("C", NOW - DAY), record("L", 0)],
			leases: [lease("L")],
			maxBytes: 3 * GB,
		});
		expect(entry(j, "A").reasons).toEqual([{ kind: "budget" }]);
		expect(entry(j, "B").verdict).toEqual({ kind: "delete", reason: "budget" });
		expect(entry(j, "C").verdict).toEqual({ kind: "keep", reason: "recent" });
		expect(entry(j, "L").verdict).toEqual({ kind: "keep", reason: "leased" });
	});
});

describe("judgeSims: foreign reasons", () => {
	test("an unavailable sim gets that reason alone", () => {
		const j = judge({ sims: [sim("A", "old", { isAvailable: false, lastBootedAt: 0, runtimeId: `${RT}iOS-17-0` })] });
		expect(entry(j, "A").reasons).toEqual([{ kind: "unavailable-runtime" }]);
		expect(entry(j, "A").verdict).toEqual({ kind: "foreign", hint: "unavailable-runtime" });
	});

	test("stale: not booted within staleMs; never-booted sims are left alone", () => {
		const j = judge({
			sims: [
				sim("A", "a", { lastBootedAt: NOW - 45 * DAY }),
				sim("B", "b", { lastBootedAt: NOW - 29 * DAY }),
				sim("C", "c"),
			],
		});
		expect(entry(j, "A").reasons).toEqual([{ kind: "stale", sinceMs: 45 * DAY }]);
		expect(entry(j, "B").reasons).toEqual([]);
		expect(entry(j, "C").reasons).toEqual([]);
		expect(entry(j, "B").verdict).toEqual({ kind: "foreign" });
	});

	test("old runtime: older than the newest available for the same device type", () => {
		const j = judge({
			sims: [
				sim("A", "a"),
				sim("B", "b", { runtimeId: `${RT}iOS-18-6` }),
				sim("C", "c", { runtimeId: `${RT}iOS-18-6`, deviceTypeIdentifier: "x.iPad-Air" }),
			],
		});
		expect(entry(j, "B").reasons).toEqual([{ kind: "old-runtime", newest: "iOS-26-5" }]);
		expect(entry(j, "C").reasons).toEqual([]);
	});

	test("old runtime only compares runtimes of the same platform", () => {
		const j = judge({ sims: [sim("I", "a"), sim("W", "w", { runtimeId: `${RT}watchOS-11-0` })] });
		expect(entry(j, "W").reasons).toEqual([]);
	});

	test("duplicate: same name + runtime keeps the most recently booted one", () => {
		const j = judge({
			sims: [
				sim("A", "iPhone 17", { lastBootedAt: NOW - 2 * DAY }),
				sim("B", "iPhone 17", { lastBootedAt: NOW - DAY }),
				sim("C", "iPhone 17"),
			],
		});
		expect(entry(j, "A").reasons).toEqual([{ kind: "duplicate", of: { udid: "B", name: "iPhone 17" } }]);
		expect(entry(j, "B").reasons).toEqual([]);
		expect(entry(j, "C").reasons).toEqual([{ kind: "duplicate", of: { udid: "B", name: "iPhone 17" } }]);
	});

	test("reasons stack", () => {
		const j = judge({
			sims: [
				sim("A", "iPhone 17"),
				sim("B", "iPhone 16", { runtimeId: `${RT}iOS-18-6`, lastBootedAt: NOW - 40 * DAY }),
				sim("C", "iPhone 16", { runtimeId: `${RT}iOS-18-6`, lastBootedAt: NOW - 50 * DAY }),
			],
		});
		expect(entry(j, "C").reasons).toEqual([
			{ kind: "stale", sinceMs: 50 * DAY },
			{ kind: "old-runtime", newest: "iOS-26-5" },
			{ kind: "duplicate", of: { udid: "B", name: "iPhone 16" } },
		]);
	});
});

describe("eligibility", () => {
	const j = judge({
		sims: [
			sim("W", "warden-iphone-17-1"),
			sim("WB", "warden-iphone-17-2", { state: "Booted" }),
			sim("WL", "warden-iphone-17-3"),
			sim("F", "foreign", { isAvailable: false }),
			sim("FB", "foreign booted", { state: "Booted", runtimeId: `${RT}iOS-18-6` }),
			sim("G", "warden-golden-iphone-17-0123456789", { isAvailable: false }),
		],
		leases: [lease("WL")],
	});

	test("prune: warden only, no blockers, a reason", () => {
		expect(
			Object.values(j)
				.filter(canPrune)
				.map((e) => e.udid)
		).toEqual(["W"]);
	});

	test("delete: any owner the user picks, except leased and goldens", () => {
		expect(
			Object.values(j)
				.filter(canDelete)
				.map((e) => e.udid)
		).toEqual(["W", "WB", "F", "FB"]);
	});

	test("suggested (pre-ticked): deletable, a reason, not booted", () => {
		expect(
			Object.values(j)
				.filter(isSuggested)
				.map((e) => e.udid)
		).toEqual(["W", "F"]);
	});

	test("verdicts say the same: suggested ⇔ delete or a hinted foreign", () => {
		const hinted = (e: SimEntry) =>
			e.verdict.kind === "delete" || (e.verdict.kind === "foreign" && e.verdict.hint !== undefined);
		expect(
			Object.values(j)
				.filter(hinted)
				.map((e) => e.udid)
		).toEqual(["W", "F"]);
		expect(entry(j, "FB").verdict).toEqual({ kind: "keep", reason: "booted" });
	});
});

describe("describeReasons", () => {
	test("reads like a hint", () => {
		expect(
			describeReasons([
				{ kind: "unavailable-runtime" },
				{ kind: "orphan" },
				{ kind: "idle", sinceMs: 9 * DAY },
				{ kind: "stale", sinceMs: 45 * DAY },
				{ kind: "old-runtime", newest: "iOS-26-5" },
				{ kind: "duplicate", of: { udid: "U2", name: "iPhone 17" } },
				{ kind: "budget" },
			])
		).toBe(
			"runtime removed · warden-named, no warden record · warden sim unused 9d · not booted in 45d · older runtime (iOS-26-5 installed) · duplicate of iPhone 17 · over --max-size (least recently used)"
		);
	});

	test("sub-day ages use the short duration", () => {
		expect(describeReasons([{ kind: "idle", sinceMs: 90 * 60_000 }])).toBe("warden sim unused 1h30m");
	});
});

describe("compareRuntimes", () => {
	test("orders by numeric version, not string", () => {
		expect(["iOS-9-0", "iOS-26-5", "iOS-18-6", "iOS-26-10"].sort(compareRuntimes)).toEqual([
			"iOS-9-0",
			"iOS-18-6",
			"iOS-26-5",
			"iOS-26-10",
		]);
	});
});
