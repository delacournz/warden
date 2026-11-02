import { describe, expect, test } from "bun:test";
import type { Budget } from "./capacity";
import type { LeaseEvent } from "./lease-events";
import type { InventoryDevice } from "./types";
import { computeWarmPlan, readWarmSet, saveWarmSet, WARM_SET_TTL_MS, warmDemand, warmEnabled } from "./warm-pool";

let id = 0;
const granted = (
	at: number,
	leaseId: string,
	profile = "iphone-17",
	platform: "ios" | "android" = "ios"
): LeaseEvent => ({
	id: ++id,
	at,
	type: "granted",
	leaseId,
	data: { platform, profile, deviceId: leaseId, deviceName: leaseId, action: "reuse", waitMs: 0 },
});
const ended = (at: number, leaseId: string, type: "released" | "expired" = "released"): LeaseEvent => ({
	id: ++id,
	at,
	type,
	leaseId,
	data: { heldMs: 1 },
});

const BIG: Budget = { memMb: 1_000_000, cpu: 100, maxUnits: Number.POSITIVE_INFINITY };

const dev = (n: number, state: InventoryDevice["state"], extra: Partial<InventoryDevice> = {}): InventoryDevice => ({
	platform: "ios",
	id: `U${n}`,
	name: `warden-iphone-17-${n}`,
	state,
	wardenCreated: true,
	profile: "iphone-17",
	...extra,
});
const ALL_SLIM = (n: number) => new Set(Array.from({ length: n }, (_, i) => `U${i + 1}`));

const plan = (over: Partial<Parameters<typeof computeWarmPlan>[0]>) =>
	computeWarmPlan({
		demand: [{ platform: "ios", profile: "iphone-17", peak: 2 }],
		pressure: "normal",
		devices: [],
		slimmed: ALL_SLIM(9),
		leased: new Set(),
		budget: BIG,
		config: {},
		...over,
	});

describe("warmEnabled", () => {
	test("off unless explicitly on", () => {
		expect(warmEnabled({})).toBe(false);
		expect(warmEnabled({ WARDEN_WARM: "0" })).toBe(false);
		expect(warmEnabled({ WARDEN_WARM: "1" })).toBe(true);
	});
});

describe("warmDemand", () => {
	test("peak overlap per profile from granted to released or expired", () => {
		const events = [
			granted(0, "a"),
			granted(10, "b"),
			ended(20, "a"),
			granted(30, "c"),
			ended(40, "b", "expired"),
			ended(50, "c"),
			granted(0, "d", "pixel-9", "android"),
			ended(5, "d"),
		];
		const out = warmDemand(events, 100);
		expect(out).toContainEqual({ platform: "ios", profile: "iphone-17", peak: 2 });
		expect(out).toContainEqual({ platform: "android", profile: "pixel-9", peak: 1 });
	});

	test("a lease still held counts until now", () => {
		expect(warmDemand([granted(0, "a"), granted(5, "b")], 100)).toEqual([
			{ platform: "ios", profile: "iphone-17", peak: 2 },
		]);
	});
});

describe("computeWarmPlan", () => {
	test("boots shut-down slim pool devices up to the target", () => {
		const out = plan({ devices: [dev(1, "shutdown"), dev(2, "shutdown"), dev(3, "shutdown")] });
		expect(out.rows[0]).toMatchObject({ target: 2, actual: 0 });
		expect(out.rows[0]?.boot.map((d) => d.id)).toEqual(["U1", "U2"]);
		expect(out.warm).toEqual(["ios:U1", "ios:U2"]);
	});

	test("counts booted devices toward the target and warms them", () => {
		const out = plan({ devices: [dev(1, "booted"), dev(2, "shutdown"), dev(3, "shutdown")] });
		expect(out.rows[0]?.boot.map((d) => d.id)).toEqual(["U2"]);
		expect(out.warm).toEqual(["ios:U1", "ios:U2"]);
	});

	test("memory pressure boots nothing but keeps the booted set", () => {
		const out = plan({ pressure: "warn", devices: [dev(1, "booted"), dev(2, "shutdown")] });
		expect(out.rows[0]?.boot).toEqual([]);
		expect(out.warm).toEqual(["ios:U1"]);
	});

	test("never boots past the budget", () => {
		const budget: Budget = { memMb: 1_000_000, cpu: 100, maxUnits: 1 };
		const out = plan({ budget, devices: [dev(1, "shutdown"), dev(2, "shutdown")] });
		expect(out.rows[0]?.target).toBe(1);
		expect(out.rows[0]?.boot).toHaveLength(1);
	});

	test("what is already booted (foreign too) uses up the budget", () => {
		const budget: Budget = { memMb: 1_000_000, cpu: 2, maxUnits: Number.POSITIVE_INFINITY };
		const foreign = dev(9, "booted", { wardenCreated: false, profile: undefined });
		const out = plan({ budget, devices: [foreign, dev(1, "booted"), dev(2, "shutdown")] });
		expect(out.rows[0]?.boot).toEqual([]);
	});

	test("never boots foreign, golden, quarantined, leased, physical or unslimmed devices", () => {
		const out = plan({
			slimmed: new Set(["U1", "U2", "U3", "U4", "U5"]),
			leased: new Set(["ios:U5"]),
			devices: [
				dev(1, "shutdown", { wardenCreated: false }),
				dev(2, "shutdown", { golden: true }),
				dev(3, "shutdown", { quarantined: true }),
				dev(4, "shutdown", { physical: { kind: "ios" } as never }),
				dev(5, "shutdown"),
				dev(6, "shutdown"),
			],
		});
		expect(out.rows[0]?.boot).toEqual([]);
	});

	test("queue head's profile is planned first and gets at least one", () => {
		const budget: Budget = { memMb: 1_000_000, cpu: 100, maxUnits: 1 };
		const other = dev(2, "shutdown", { profile: "ipad", name: "warden-ipad-1" });
		const out = plan({
			budget,
			queueHead: { platform: "ios", profile: "ipad" },
			demand: [{ platform: "ios", profile: "iphone-17", peak: 3 }],
			devices: [dev(1, "shutdown"), other],
		});
		expect(out.rows[0]).toMatchObject({ profile: "ipad", target: 1 });
		expect(out.rows[0]?.boot.map((d) => d.id)).toEqual(["U2"]);
		expect(out.rows[1]?.boot).toEqual([]);
	});

	test("never creates: no shut-down device means nothing to boot", () => {
		expect(plan({ devices: [] }).rows[0]).toMatchObject({ target: 2, actual: 0, boot: [] });
	});
});

describe("warm set persistence", () => {
	const meta = () => {
		const m = new Map<string, string>();
		return { getMeta: (k: string) => m.get(k), setMeta: (k: string, v: string) => void m.set(k, v) };
	};
	test("round trip, expires after the TTL", () => {
		const s = meta();
		saveWarmSet(s, ["ios:U1"], 1_000);
		expect([...readWarmSet(s, 2_000)]).toEqual(["ios:U1"]);
		expect(readWarmSet(s, 1_000 + WARM_SET_TTL_MS + 1).size).toBe(0);
	});
	test("unset or malformed is empty", () => {
		const s = meta();
		expect(readWarmSet(s, 0).size).toBe(0);
		s.setMeta("warm_set", "{nope");
		expect(readWarmSet(s, 0).size).toBe(0);
	});
});
