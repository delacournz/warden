import { describe, expect, test } from "bun:test";
import { roomFor } from "./room";
import type { InventoryDevice } from "./types";

const dev = (id: string, platform: "ios" | "android", state: InventoryDevice["state"]): InventoryDevice =>
	({ id, name: id, platform, state, profile: "p" }) as InventoryDevice;

const budget = (cpu: number) => ({ memMb: 1_000_000, cpu, maxUnits: Number.POSITIVE_INFINITY });

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
});
