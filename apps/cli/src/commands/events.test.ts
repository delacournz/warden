import { afterEach, describe, expect, test } from "bun:test";
import { type TestContext, testContext } from "../testing";
import { runEvents } from "./events";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const NOW = 10 * 3_600_000;

function seed(c: TestContext) {
	c.db.recordEvent({
		at: NOW - 3 * 3_600_000,
		type: "released",
		data: { heldMs: 5 },
		leaseId: "l_old",
		ownerKey: "agent:old",
	});
	c.db.recordEvent({
		at: NOW - 60_000,
		type: "granted",
		data: {
			platform: "ios",
			profile: "iphone-17",
			deviceId: "U1",
			deviceName: "warden-iphone-17-1",
			action: "boot",
			waitMs: 2_000,
		},
		leaseId: "l_new",
		ownerKey: "agent:abc123",
		label: "e2e",
	});
}

const never = { sleep: async () => {}, aborted: () => false };

describe("warden events", () => {
	test("--json prints every event oldest first", async () => {
		ctx = testContext(["--json"], { now: () => NOW });
		seed(ctx);
		expect(await runEvents(ctx, { json: true }, never)).toBe(0);
		const out = JSON.parse(ctx.stdout.join("\n"));
		expect(out.events.map((e: { leaseId: string }) => e.leaseId)).toEqual(["l_old", "l_new"]);
	});

	test("--since, --lease and --owner (substring) filter", async () => {
		ctx = testContext([], { now: () => NOW });
		seed(ctx);
		await runEvents(ctx, { json: true, since: "1h" }, never);
		expect(JSON.parse(ctx.stdout.join("\n")).events.map((e: { leaseId: string }) => e.leaseId)).toEqual(["l_new"]);
		ctx.stdout.length = 0;
		await runEvents(ctx, { json: true, lease: "l_old" }, never);
		expect(JSON.parse(ctx.stdout.join("\n")).events).toHaveLength(1);
		ctx.stdout.length = 0;
		await runEvents(ctx, { json: true, owner: "abc" }, never);
		expect(JSON.parse(ctx.stdout.join("\n")).events[0].leaseId).toBe("l_new");
	});

	test("the table shows the event, lease, label and detail", async () => {
		ctx = testContext([], { now: () => NOW });
		seed(ctx);
		await runEvents(ctx, { since: "1h" }, never);
		const text = ctx.stdout.join("\n");
		expect(text).toContain("granted");
		expect(text).toContain("l_new");
		expect(text).toContain("e2e");
		expect(text).toContain("waited 2s");
	});

	test("empty history", async () => {
		ctx = testContext([], { now: () => NOW });
		await runEvents(ctx, {}, never);
		expect(ctx.stdout.join("\n")).toContain("no events");
	});

	test("a bad --since is a usage error", async () => {
		ctx = testContext([], { now: () => NOW });
		expect(await runEvents(ctx, { since: "soon" }, never)).toBe(1);
	});

	test("--follow --json prints new events as NDJSON, then stops on abort", async () => {
		ctx = testContext([], { now: () => NOW });
		seed(ctx);
		let ticks = 0;
		const c = ctx;
		const deps = {
			sleep: async () => {
				ticks++;
				c.db.recordEvent({ at: NOW + ticks, type: "released", data: { heldMs: ticks }, leaseId: `l_${ticks}` });
			},
			aborted: () => ticks >= 2,
		};
		expect(await runEvents(ctx, { follow: true, json: true }, deps)).toBe(0);
		const lines = ctx.stdout.map((l) => JSON.parse(l) as { leaseId: string });
		expect(lines.map((e) => e.leaseId)).toEqual(["l_1", "l_2"]);
	});

	test("--follow with --since prints the matching history first", async () => {
		ctx = testContext([], { now: () => NOW });
		seed(ctx);
		const deps = { sleep: async () => {}, aborted: () => true };
		await runEvents(ctx, { follow: true, json: true, since: "1h" }, deps);
		expect(ctx.stdout.map((l) => JSON.parse(l).leaseId)).toEqual(["l_new"]);
	});
});
