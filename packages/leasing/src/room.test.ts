import { describe, expect, test } from "bun:test";
import type { InventoryDevice } from "@delacour/warden-store/types";
import { DEFAULT_COSTS, SLIM_IOS_MEM_MB } from "./capacity";
import type { CapacityDeps } from "./claim";
import { RoomCalculator } from "./room";

const dev = (id: string, platform: "ios" | "android", state: InventoryDevice["state"]): InventoryDevice =>
	({ id, name: id, platform, state, profile: "p" }) as InventoryDevice;

const budget = (cpu: number) => ({ memMb: 1_000_000, cpu, maxUnits: Number.POSITIVE_INFINITY });
const memBudget = (memMb: number) => ({ memMb, cpu: 100, maxUnits: Number.POSITIVE_INFINITY });

describe("roomFor", () => {
	test("empty host: the budget's worth of sims", () => {
		expect(new RoomCalculator({ budget: budget(3), config: {} } as CapacityDeps).roomFor([], "ios")).toBe(3);
	});

	test("booted devices (any platform) use up the budget; shutdown ones do not", () => {
		const inv = [dev("a", "ios", "booted"), dev("b", "android", "booting"), dev("c", "ios", "shutdown")];
		expect(new RoomCalculator({ budget: budget(5), config: {} } as CapacityDeps).roomFor(inv, "ios")).toBe(2);
	});

	test("a full host has no room", () => {
		expect(
			new RoomCalculator({ budget: budget(1), config: {} } as CapacityDeps).roomFor([dev("a", "ios", "booted")], "ios")
		).toBe(0);
	});

	test("new iOS sims count slim, so memory binds later", () => {
		// two slim sims fit where one stock one would; no Android emulator does
		const mem = memBudget(SLIM_IOS_MEM_MB * 2);
		expect(new RoomCalculator({ budget: mem, config: {} } as CapacityDeps).roomFor([], "ios")).toBe(2);
		expect(new RoomCalculator({ budget: mem, config: {} } as CapacityDeps).roomFor([], "android")).toBe(0);
	});

	test("a slimmed booted sim costs less than a stock one", () => {
		// a stock booted sim leaves room for one more slim sim; marking it slim frees a second slim slot
		const mem = memBudget(DEFAULT_COSTS.ios.memMb + SLIM_IOS_MEM_MB);
		const inv = [dev("a", "ios", "booted")];
		expect(new RoomCalculator({ budget: mem, config: {} } as CapacityDeps).roomFor(inv, "ios")).toBe(1);
		expect(new RoomCalculator({ budget: mem, config: {} } as CapacityDeps).roomFor(inv, "ios", new Set(["a"]))).toBe(2);
	});

	test("slimNew=false counts new sims stock, so less fits", () => {
		const mem = memBudget(SLIM_IOS_MEM_MB * 2);
		const slim = new RoomCalculator({ budget: mem, config: {} } as CapacityDeps).roomFor([], "ios");
		const stock = new RoomCalculator({ budget: mem, config: {} } as CapacityDeps).roomFor([], "ios", new Set(), false);
		expect(stock).toBeLessThan(slim);
	});
});
