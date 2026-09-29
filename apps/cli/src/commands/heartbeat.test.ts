import { afterEach, describe, expect, test } from "bun:test";
import type { Owner } from "@warden/core/types";
import { OWNER_ENV } from "../simctl.testing";
import { type TestContext, testContext } from "../testing";
import { heartbeatCommand } from "./heartbeat";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const me: Owner = { kind: "agent", sessionId: "me", cwd: "/" };
const other: Owner = { kind: "agent", sessionId: "other", cwd: "/" };

describe("warden heartbeat", () => {
	test("by id, --mine, --session", async () => {
		let clock = 1_000;
		ctx = testContext([], { now: () => clock });
		ctx.env = { ...ctx.env, ...OWNER_ENV };
		const a = ctx.db.insertLease({ resource: { kind: "port", port: 1 }, owner: me, ttlMs: 10 }, 0);
		const b = ctx.db.insertLease({ resource: { kind: "port", port: 2 }, owner: other, ttlMs: 10 }, 0);

		ctx.argv = [a.id, "--json"];
		expect(await heartbeatCommand.run(ctx)).toBe(0);
		expect(ctx.db.getLease(a.id)?.heartbeatAt).toBe(1_000);
		expect(JSON.parse(ctx.stdout.join("\n"))).toEqual({ heartbeat: [a.id], unknown: [] });

		clock = 2_000;
		ctx.argv = ["--mine"];
		expect(await heartbeatCommand.run(ctx)).toBe(0);
		expect(ctx.db.getLease(a.id)?.heartbeatAt).toBe(2_000);
		expect(ctx.db.getLease(b.id)?.heartbeatAt).toBe(0);

		ctx.argv = ["--session", "other"];
		expect(await heartbeatCommand.run(ctx)).toBe(0);
		expect(ctx.db.getLease(b.id)?.heartbeatAt).toBe(2_000);
	});

	test("unknown id / nothing selected → exit 1", async () => {
		ctx = testContext(["l_gone"]);
		expect(await heartbeatCommand.run(ctx)).toBe(1);
		ctx.argv = [];
		expect(await heartbeatCommand.run(ctx)).toBe(1);
	});
});
