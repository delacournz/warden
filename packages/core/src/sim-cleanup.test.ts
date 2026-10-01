import { describe, expect, test } from "bun:test";
import type { SimDetail } from "./providers/ios";
import { compareRuntimes, type SuggestOptions, suggestSimDeletions } from "./sim-cleanup";
import type { DeviceRecord } from "./store";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const IPHONE_17 = "com.apple.CoreSimulator.SimDeviceType.iPhone-17";

function sim(id: string, over: Partial<SimDetail> = {}): SimDetail {
	return {
		platform: "ios",
		id,
		name: `sim ${id}`,
		state: "shutdown",
		wardenCreated: false,
		runtime: "iOS-26-5",
		available: true,
		deviceType: IPHONE_17,
		lastBootedAt: NOW - DAY,
		...over,
	};
}

function record(id: string, lastUsedAt: number): DeviceRecord {
	return { platform: "ios", id, name: `sim ${id}`, createdAt: 0, lastUsedAt };
}

const opts = (over: Partial<SuggestOptions> = {}): SuggestOptions => ({
	now: NOW,
	staleMs: 30 * DAY,
	idleMs: 7 * DAY,
	records: [],
	...over,
});

const suggest = (sims: SimDetail[], o: Partial<SuggestOptions> = {}) =>
	Object.fromEntries(suggestSimDeletions(sims, opts(o)));

describe("suggestSimDeletions", () => {
	test("recently booted, unique, newest-runtime sims aren't suggested", () => {
		expect(suggest([sim("A"), sim("B")])).toEqual({});
	});

	test("an unavailable sim (runtime removed) is suggested for that reason alone", () => {
		expect(suggest([sim("A", { available: false, runtime: "iOS-17-0", lastBootedAt: 0 })])).toEqual({
			A: [{ kind: "unavailable" }],
		});
	});

	test("stale: not booted within staleMs; never-booted sims are left alone", () => {
		expect(
			suggest([
				sim("A", { lastBootedAt: NOW - 45 * DAY }),
				sim("B", { lastBootedAt: NOW - 29 * DAY }),
				sim("C", { lastBootedAt: undefined }),
			])
		).toEqual({ A: [{ kind: "stale", sinceMs: 45 * DAY }] });
	});

	test("old runtime: an older iOS than the newest available for the same device type", () => {
		const result = suggest([
			sim("A", { runtime: "iOS-26-5" }),
			sim("B", { runtime: "iOS-18-6" }),
			sim("C", { runtime: "iOS-18-6", deviceType: "com.apple.CoreSimulator.SimDeviceType.iPad-Air" }),
		]);
		expect(result).toEqual({ B: [{ kind: "old-runtime", newest: "iOS-26-5" }] });
	});

	test("duplicate: same name + runtime keeps the most recently booted one", () => {
		const result = suggest([
			sim("A", { name: "iPhone 17", lastBootedAt: NOW - 2 * DAY }),
			sim("B", { name: "iPhone 17", lastBootedAt: NOW - DAY }),
			sim("C", { name: "iPhone 17", lastBootedAt: undefined }),
		]);
		expect(result).toEqual({
			A: [{ kind: "duplicate", of: { id: "B", name: "iPhone 17" } }],
			C: [{ kind: "duplicate", of: { id: "B", name: "iPhone 17" } }],
		});
	});

	test("idle warden pool sim: by the store's lastUsedAt (falls back to lastBootedAt), instead of stale", () => {
		const result = suggest(
			[
				sim("W1", { wardenCreated: true, lastBootedAt: NOW - 60 * DAY }),
				sim("W2", { wardenCreated: true, lastBootedAt: NOW - 60 * DAY }),
				sim("W3", { wardenCreated: true, lastBootedAt: NOW - 8 * DAY }),
			],
			{ records: [record("W1", NOW - 10 * DAY), record("W2", NOW - DAY)] }
		);
		expect(result).toEqual({
			W1: [{ kind: "idle-pool", sinceMs: 10 * DAY }],
			W3: [{ kind: "idle-pool", sinceMs: 8 * DAY }],
		});
	});

	test("reasons stack", () => {
		const result = suggest([
			sim("A", { name: "iPhone 17", runtime: "iOS-26-5" }),
			sim("B", { name: "iPhone 16", runtime: "iOS-18-6", lastBootedAt: NOW - 40 * DAY }),
			sim("C", { name: "iPhone 16", runtime: "iOS-18-6", lastBootedAt: NOW - 50 * DAY }),
		]);
		expect(result.C).toEqual([
			{ kind: "stale", sinceMs: 50 * DAY },
			{ kind: "old-runtime", newest: "iOS-26-5" },
			{ kind: "duplicate", of: { id: "B", name: "iPhone 16" } },
		]);
	});

	test("goldens are never suggested", () => {
		expect(suggest([sim("G", { golden: true, available: false })])).toEqual({});
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
