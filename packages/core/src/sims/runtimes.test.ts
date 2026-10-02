import { describe, expect, test } from "bun:test";
import type { SimAuditEntry } from "./audit";
import { auditRuntimes, type DiskRuntime, parseRuntimeList } from "./runtimes";

const GB = 1024 ** 3;
const RT = "com.apple.CoreSimulator.SimRuntime.";

const RUNTIME_LIST_JSON = JSON.stringify({
	"5A8D2AC8-603C-4B91-B39C-8C6B72F48495": {
		build: "23B86",
		deletable: true,
		identifier: "5A8D2AC8-603C-4B91-B39C-8C6B72F48495",
		lastUsedAt: "2026-09-25T01:11:06Z",
		platformIdentifier: "com.apple.platform.iphonesimulator",
		runtimeIdentifier: `${RT}iOS-26-1`,
		sizeBytes: 8344869917,
		state: "Ready",
		version: "26.1",
	},
	"DBF0B7C8-386A-46DB-BDD1-91B66F628310": {
		build: "23F77",
		deletable: false,
		identifier: "DBF0B7C8-386A-46DB-BDD1-91B66F628310",
		runtimeIdentifier: `${RT}iOS-26-5`,
		sizeBytes: 8494282293,
		state: "Ready",
		version: "26.5",
	},
	junk: { identifier: 3 },
});

function runtime(short: string, extra: Partial<DiskRuntime> = {}): DiskRuntime {
	return {
		identifier: `ID-${short}`,
		runtimeIdentifier: `${RT}${short}`,
		runtime: short,
		version: short,
		build: "B",
		sizeBytes: 8 * GB,
		state: "Ready",
		deletable: true,
		...extra,
	};
}

function sim(udid: string, short: string, verdict: SimAuditEntry["verdict"]): SimAuditEntry {
	return {
		udid,
		name: udid,
		runtimeId: `${RT}${short}`,
		runtime: short,
		state: "Shutdown",
		isAvailable: true,
		bytes: GB,
		owner: verdict.kind === "foreign" ? "foreign" : "warden",
		leased: false,
		verdict,
	};
}

describe("parseRuntimeList", () => {
	test("reads `simctl runtime list -j`, skipping malformed entries", () => {
		const parsed = parseRuntimeList(RUNTIME_LIST_JSON);
		expect(parsed.success && parsed.data).toEqual([
			{
				identifier: "5A8D2AC8-603C-4B91-B39C-8C6B72F48495",
				runtimeIdentifier: `${RT}iOS-26-1`,
				runtime: "iOS-26-1",
				version: "26.1",
				build: "23B86",
				sizeBytes: 8344869917,
				state: "Ready",
				deletable: true,
				lastUsedAt: Date.parse("2026-09-25T01:11:06Z"),
			},
			{
				identifier: "DBF0B7C8-386A-46DB-BDD1-91B66F628310",
				runtimeIdentifier: `${RT}iOS-26-5`,
				runtime: "iOS-26-5",
				version: "26.5",
				build: "23F77",
				sizeBytes: 8494282293,
				state: "Ready",
				deletable: false,
			},
		]);
	});

	test("invalid JSON is an error", () => {
		expect(parseRuntimeList("nope").success).toBe(false);
	});
});

describe("auditRuntimes", () => {
	const keep = { kind: "keep", reason: "recent" } as const;
	const drop = { kind: "delete", reason: "idle" } as const;

	test("counts sims per runtime and gives each runtime a verdict", () => {
		const report = auditRuntimes(
			[runtime("iOS-26-1"), runtime("iOS-26-3"), runtime("iOS-26-5"), runtime("iOS-18-0", { deletable: false })],
			[sim("A", "iOS-26-5", keep), sim("F", "iOS-26-5", { kind: "foreign" }), sim("B", "iOS-26-3", drop)]
		);
		const byRuntime = Object.fromEntries(report.entries.map((e) => [e.runtime, e]));
		expect(byRuntime["iOS-26-5"]).toMatchObject({ sims: 2, wardenSims: 1, verdict: { kind: "in-use" } });
		expect(byRuntime["iOS-26-3"]).toMatchObject({ sims: 1, verdict: { kind: "unused-after-prune" } });
		expect(byRuntime["iOS-26-1"]).toMatchObject({ sims: 0, verdict: { kind: "unused" } });
		expect(byRuntime["iOS-18-0"]).toMatchObject({ sims: 0, verdict: { kind: "protected" } });
		expect(report.totalBytes).toBe(32 * GB);
		expect(report.unusedBytes).toBe(8 * GB);
		expect(report.unusedAfterPruneBytes).toBe(16 * GB);
	});

	test("sorted by size desc", () => {
		const report = auditRuntimes([runtime("iOS-26-1", { sizeBytes: GB }), runtime("iOS-26-5")], []);
		expect(report.entries.map((e) => e.runtime)).toEqual(["iOS-26-5", "iOS-26-1"]);
	});
});
