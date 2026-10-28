import { afterEach, describe, expect, test } from "bun:test";
import type { DiskFacts, DiskVerdict } from "@delacour/warden-core/disk";
import { type TestContext, testContext } from "../testing";
import { handleSessionStart, SESSION_START_CACHE_MS } from "./session-start";

const GB = 1024 ** 3;
let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const sick: { facts: DiskFacts; verdict: DiskVerdict } = {
	facts: { freeBytes: 6 * GB, swapUsedBytes: 14 * GB },
	verdict: {
		level: "critical",
		reasons: [
			{ kind: "swap", swapUsedBytes: 14 * GB, warnBytes: 8 * GB },
			{ kind: "low-free", freeBytes: 6 * GB, floorBytes: 20 * GB, criticalBytes: 8 * GB },
		],
	},
};
const healthy = { facts: { freeBytes: 300 * GB }, verdict: { level: "ok", reasons: [] } satisfies DiskVerdict };

function run(c: TestContext, disk: typeof sick, reads: { n: number }, enabled = true) {
	return handleSessionStart({
		store: c.store,
		now: c.now,
		enabled,
		readDisk: async () => {
			reads.n++;
			return disk;
		},
	});
}

describe("handleSessionStart", () => {
	test("one short line naming free space and swap when the disk is sick", async () => {
		ctx = testContext([]);
		const line = await run(ctx, sick, { n: 0 });
		expect(line).toBe(
			"warden: swap 14.0G, disk 6.0G free — reuse booted devices, avoid parallel builds; see `warden disk`"
		);
		expect(line).not.toContain("\n");
	});

	test("nothing when the disk is healthy", async () => {
		ctx = testContext([]);
		expect(await run(ctx, healthy, { n: 0 })).toBeUndefined();
	});

	test("nothing when WARDEN_DISK=off, and the disk is never read", async () => {
		ctx = testContext([]);
		const reads = { n: 0 };
		expect(await run(ctx, sick, reads, false)).toBeUndefined();
		expect(reads.n).toBe(0);
	});

	test("the verdict is cached for 60 s in the store, then read again", async () => {
		let now = 1_000_000;
		ctx = testContext([], { now: () => now });
		const reads = { n: 0 };
		await run(ctx, sick, reads);
		now += SESSION_START_CACHE_MS - 1;
		expect(await run(ctx, healthy, reads)).toContain("swap");
		expect(reads.n).toBe(1);
		now += 1;
		expect(await run(ctx, healthy, reads)).toBeUndefined();
		expect(reads.n).toBe(2);
	});

	test("a failing read prints nothing and does not throw", async () => {
		ctx = testContext([]);
		const line = await handleSessionStart({
			store: ctx.store,
			now: ctx.now,
			enabled: true,
			readDisk: async () => {
				throw new Error("boom");
			},
		});
		expect(line).toBeUndefined();
	});
});
