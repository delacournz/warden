import { describe, expect, test } from "bun:test";
import { BOOT_SECONDS, claim, initialShelf, release, tick } from "./shelf";

describe("claim", () => {
	test("reuses an already-booted free device first", () => {
		const next = claim(initialShelf());
		const slot = next.slots[2];
		expect(slot.phase).toBe("leased");
		expect(slot.mine).toBe(true);
		expect(next.slots[3].phase).toBe("empty");
		expect(next.notice).toContain("reused");
	});

	test("clones a new device from the golden image when none is free", () => {
		const next = claim(claim(initialShelf()));
		expect(next.slots[3].phase).toBe("booting");
		expect(next.notice).toContain("golden");
	});

	test("waits when the pool is at --max and everything is leased", () => {
		const full = tick(claim(claim(initialShelf())), BOOT_SECONDS);
		const next = claim(full);
		expect(next.slots).toEqual(full.slots);
		expect(next.notice).toContain("--max 4");
	});

	test("never hands out another owner's device", () => {
		const next = tick(claim(claim(claim(initialShelf()))), BOOT_SECONDS);
		expect(next.slots[0].owner).toBe(initialShelf().slots[0].owner);
		expect(next.slots[1].owner).toBe(initialShelf().slots[1].owner);
	});
});

describe("tick", () => {
	test("a booting device is leased once its boot completes", () => {
		const booting = claim(claim(initialShelf()));
		expect(tick(booting, BOOT_SECONDS - 1).slots[3].phase).toBe("booting");
		const done = tick(booting, BOOT_SECONDS);
		expect(done.slots[3].phase).toBe("leased");
		expect(done.slots[3].bootElapsed).toBe(BOOT_SECONDS);
	});
});

describe("release", () => {
	test("releases only my leases and leaves the devices booted", () => {
		const mine = tick(claim(claim(initialShelf())), BOOT_SECONDS);
		const next = release(mine);
		expect(next.slots[2]).toMatchObject({ phase: "booted", owner: null, mine: false });
		expect(next.slots[3]).toMatchObject({ phase: "booted", owner: null, mine: false });
		expect(next.slots[0].phase).toBe("leased");
		expect(next.notice).toContain("released 2");
	});
});
