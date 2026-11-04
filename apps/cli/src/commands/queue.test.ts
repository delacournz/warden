import { afterEach, describe, expect, test } from "bun:test";
import { PRIORITY, type WaitReason } from "@delacour/warden-core/queue";
import type { Owner } from "@delacour/warden-core/types";
import { type TestContext, testContext } from "../testing";
import { queueCommand } from "./queue";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const agent: Owner = { kind: "agent", sessionId: "abc", cwd: "/w", repo: "salient", worktree: "cowrie@main" };

function row(c: TestContext, id: string, priority: number, enqueuedAt: number, label?: string, reason?: WaitReason) {
	c.db.enqueue({
		id,
		platform: "ios",
		profile: "iphone-17",
		units: 1,
		priority,
		enqueuedAt,
		heartbeatAt: enqueuedAt,
		owner: agent,
		pid: process.pid,
		...(label !== undefined ? { label } : {}),
		...(reason !== undefined ? { reason } : {}),
	});
}

describe("warden queue", () => {
	test("empty", async () => {
		ctx = testContext([]);
		expect(await queueCommand.run(ctx)).toBe(0);
		expect(ctx.stdout.join("\n")).toContain("queue empty");
	});

	test("--json lists rows in queue order with names and aging", async () => {
		ctx = testContext(["--json"], { now: () => 30 * 60_000 });
		row(ctx, "q_old_low", PRIORITY.low, 0, "batch");
		row(ctx, "q_new_high", PRIORITY.high, 29 * 60_000);
		expect(await queueCommand.run(ctx)).toBe(0);
		const out = JSON.parse(ctx.stdout.join("\n"));
		expect(out.queue.map((r: { id: string }) => r.id)).toEqual(["q_old_low", "q_new_high"]);
		expect(out.queue[0]).toMatchObject({
			position: 1,
			priority: "low",
			aged: 30,
			effectivePriority: 30,
			ageMs: 30 * 60_000,
			platform: "ios",
			label: "batch",
			pid: process.pid,
		});
	});

	test("table shows position, priority and age", async () => {
		ctx = testContext([], { now: () => 20 * 60_000 });
		row(ctx, "q1", PRIORITY.low, 0);
		expect(await queueCommand.run(ctx)).toBe(0);
		const text = ctx.stdout.join("\n");
		expect(text).toContain("low +20");
		expect(text).toContain("20m");
		expect(text).toContain("salient/cowrie@main");
	});

	test("--json carries the stored reason; device waiters have no position and sort after the boot queue", async () => {
		ctx = testContext(["--json"], { now: () => 10 * 60_000 });
		row(ctx, "q_polling", PRIORITY.interactive, 0, undefined, "device-limit");
		row(ctx, "q_gated", PRIORITY.low, 5 * 60_000, undefined, "ram-budget");
		row(ctx, "q_legacy", PRIORITY.low, 6 * 60_000);
		expect(await queueCommand.run(ctx)).toBe(0);
		const out = JSON.parse(ctx.stdout.join("\n"));
		expect(out.queue.map((r: { id: string }) => r.id)).toEqual(["q_gated", "q_legacy", "q_polling"]);
		expect(out.queue[0]).toMatchObject({ position: 1, reason: "ram-budget" });
		expect(out.queue[1].position).toBe(2);
		expect(out.queue[1].reason).toBeUndefined();
		expect(out.queue[2]).toMatchObject({ reason: "device-limit" });
		expect(out.queue[2].position).toBeUndefined();
	});

	test("table has a REASON column", async () => {
		ctx = testContext([], { now: () => 60_000 });
		row(ctx, "q1", PRIORITY.normal, 0, undefined, "memory-pressure");
		expect(await queueCommand.run(ctx)).toBe(0);
		const text = ctx.stdout.join("\n");
		expect(text).toContain("REASON");
		expect(text).toContain("memory-pressure");
	});
});
