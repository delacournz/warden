import { describe, expect, test } from "bun:test";
import { SLIM_IOS_MEM_MB } from "./capacity";
import { roomFor } from "./room";
import type { InventoryDevice } from "./types";

const dev = (id: string, platform: "ios" | "android", state: InventoryDevice["state"]): InventoryDevice =>
	({ id, name: id, platform, state, profile: "p" }) as InventoryDevice;

const budget = (cpu: number) => ({ memMb: 1_000_000, cpu, maxUnits: Number.POSITIVE_INFINITY });
const memBudget = (memMb: number) => ({ memMb, cpu: 100, maxUnits: Number.POSITIVE_INFINITY });

describe("roomFor", () => {
	test("empty host: the budget's worth of sims", () => {
		expect(roomFor([], "ios", { budget: budget(3), config: {} })).toBe(3);
	});

	test("booted devices (any platform) use up the budget; shutdown ones do not", () => {
		const inv = [dev("a", "ios", "booted"), dev("b", "android", "booting"), dev("c", "ios", "shutdown")];
		expect(roomFor(inv, "ios", { budget: budget(5), config: {} })).toBe(2);
	});

	test("a full host has no room", () => {
		expect(roomFor([dev("a", "ios", "booted")], "ios", { budget: budget(1), config: {} })).toBe(0);
	});

	test("new iOS sims count slim, so memory binds later", () => {
		// two slim sims fit where one stock one would; no Android emulator does
		const mem = memBudget(SLIM_IOS_MEM_MB * 2);
		expect(roomFor([], "ios", { budget: mem, config: {} })).toBe(2);
		expect(roomFor([], "android", { budget: mem, config: {} })).toBe(0);
	});

	test("a slimmed booted sim costs less than a stock one", () => {
		// three slim slots: a stock booted sim leaves room for one more slim sim, a slimmed one for two
		const mem = memBudget(SLIM_IOS_MEM_MB * 3);
		const inv = [dev("a", "ios", "booted")];
		expect(roomFor(inv, "ios", { budget: mem, config: {} })).toBe(1);
		expect(roomFor(inv, "ios", { budget: mem, config: {} }, new Set(["a"]))).toBe(2);
	});

	test("slimNew=false counts new sims stock, so less fits", () => {
		const mem = memBudget(SLIM_IOS_MEM_MB * 2);
		const slim = roomFor([], "ios", { budget: mem, config: {} });
		const stock = roomFor([], "ios", { budget: mem, config: {} }, new Set(), false);
		expect(stock).toBeLessThan(slim);
	});
});
