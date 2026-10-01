import { describe, expect, test } from "bun:test";
import type { GoldenSim } from "../golden/golden";
import type { DeviceRecord } from "../store";
import { type AuditInput, auditSims } from "./audit";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const GB = 1024 ** 3;

function sim(udid: string, name: string, extra: Partial<GoldenSim> = {}): GoldenSim {
	return {
		udid,
		name,
		state: "Shutdown",
		isAvailable: true,
		runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
		dataPathSize: GB,
		...extra,
	};
}

function record(id: string, lastUsedAt: number): DeviceRecord {
	return { platform: "ios", id, name: `warden-iphone-17-${id}`, createdAt: 0, lastUsedAt };
}

function input(overrides: Partial<AuditInput>): AuditInput {
	return { sims: [], records: [], leased: new Set(), now: NOW, idleMs: 7 * DAY, ...overrides };
}

const verdictOf = (udid: string, i: AuditInput) => auditSims(i).entries.find((e) => e.udid === udid)?.verdict;

describe("auditSims", () => {
	test("classifies owners: store record / warden- name = warden, golden, else foreign", () => {
		const report = auditSims(
			input({
				sims: [
					sim("A", "warden-iphone-17-1"),
					sim("B", "my phone"),
					sim("C", "warden-golden-iphone-17-0123456789"),
					sim("D", "renamed by user"),
				],
				records: [record("A", NOW), record("D", NOW)],
			})
		);
		const owners = report.entries.map((e) => [e.udid, e.owner]).sort(([a], [b]) => String(a).localeCompare(String(b)));
		expect(owners).toEqual([
			["A", "warden"],
			["B", "foreign"],
			["C", "golden"],
			["D", "warden"],
		]);
	});

	test("leased and booted warden sims are kept even when idle or unavailable", () => {
		const sims = [
			sim("A", "warden-iphone-17-1", { isAvailable: false }),
			sim("B", "warden-iphone-17-2", { state: "Booted" }),
		];
		const i = input({ sims, records: [record("A", 0), record("B", 0)], leased: new Set(["A"]) });
		expect(verdictOf("A", i)).toEqual({ kind: "keep", reason: "leased" });
		expect(verdictOf("B", i)).toEqual({ kind: "keep", reason: "booted" });
	});

	test("unavailable runtime, orphan and idle warden sims are deletable; recent kept", () => {
		const sims = [
			sim("A", "warden-iphone-17-1", { isAvailable: false }),
			sim("B", "warden-iphone-17-2"),
			sim("C", "warden-iphone-17-3"),
			sim("D", "warden-iphone-17-4"),
		];
		const i = input({ sims, records: [record("A", NOW), record("C", NOW - 8 * DAY), record("D", NOW - DAY)] });
		expect(verdictOf("A", i)).toEqual({ kind: "delete", reason: "unavailable-runtime" });
		expect(verdictOf("B", i)).toEqual({ kind: "delete", reason: "orphan" });
		expect(verdictOf("C", i)).toEqual({ kind: "delete", reason: "idle" });
		expect(verdictOf("D", i)).toEqual({ kind: "keep", reason: "recent" });
	});

	test("a recent lastBootedAt counts as use", () => {
		const i = input({
			sims: [sim("A", "warden-iphone-17-1", { lastBootedAt: NOW - DAY })],
			records: [record("A", NOW - 30 * DAY)],
		});
		expect(verdictOf("A", i)).toEqual({ kind: "keep", reason: "recent" });
		expect(auditSims(i).entries[0]?.lastUsedAt).toBe(NOW - DAY);
	});

	test("goldens are kept; foreign sims are never deletable, only hinted", () => {
		const i = input({
			sims: [
				sim("G", "warden-golden-iphone-17-0123456789", { isAvailable: false }),
				sim("F1", "old", { isAvailable: false }),
				sim("F2", "stale", { lastBootedAt: NOW - 30 * DAY }),
				sim("F3", "fresh", { lastBootedAt: NOW - DAY }),
			],
		});
		expect(verdictOf("G", i)).toEqual({ kind: "keep", reason: "golden" });
		expect(verdictOf("F1", i)).toEqual({ kind: "foreign", hint: "unavailable-runtime" });
		expect(verdictOf("F2", i)).toEqual({ kind: "foreign", hint: "idle" });
		expect(verdictOf("F3", i)).toEqual({ kind: "foreign" });
		const report = auditSims(i);
		expect(report.reclaimableBytes).toBe(0);
		expect(report.foreignReclaimableBytes).toBe(2 * GB);
	});

	test("totals and sort by size desc", () => {
		const report = auditSims(
			input({
				sims: [
					sim("A", "warden-iphone-17-1", { dataPathSize: GB }),
					sim("B", "warden-iphone-17-2", { dataPathSize: 3 * GB }),
					sim("C", "x"),
				],
				records: [record("A", 0), record("B", NOW)],
			})
		);
		expect(report.entries.map((e) => e.udid)).toEqual(["B", "A", "C"]);
		expect(report.totalBytes).toBe(5 * GB);
		expect(report.reclaimableBytes).toBe(GB);
		expect(report.overBudget).toBe(false);
	});

	test("--max-size: deletes least-recently-used recent warden sims until under budget", () => {
		const sims = [
			sim("A", "warden-iphone-17-1"),
			sim("B", "warden-iphone-17-2"),
			sim("C", "warden-iphone-17-3"),
			sim("L", "warden-iphone-17-4"),
			sim("F", "foreign"),
		];
		const records = [record("A", NOW - 3 * DAY), record("B", NOW - 2 * DAY), record("C", NOW - DAY), record("L", 0)];
		const report = auditSims(input({ sims, records, leased: new Set(["L"]), maxBytes: 3 * GB }));
		const verdicts = Object.fromEntries(report.entries.map((e) => [e.udid, e.verdict]));
		expect(verdicts.A).toEqual({ kind: "delete", reason: "budget" });
		expect(verdicts.B).toEqual({ kind: "delete", reason: "budget" });
		expect(verdicts.C).toEqual({ kind: "keep", reason: "recent" });
		expect(verdicts.L).toEqual({ kind: "keep", reason: "leased" });
		expect(report.afterBytes).toBe(3 * GB);
		expect(report.overBudget).toBe(false);
	});

	test("over budget even after pruning everything eligible is reported", () => {
		const report = auditSims(input({ sims: [sim("F", "foreign", { dataPathSize: 5 * GB })], maxBytes: GB }));
		expect(report.overBudget).toBe(true);
	});

	test("missing size counts as 0", () => {
		const unsized = sim("A", "x");
		delete unsized.dataPathSize;
		const report = auditSims(input({ sims: [unsized] }));
		expect(report.entries[0]?.bytes).toBe(0);
	});
});
