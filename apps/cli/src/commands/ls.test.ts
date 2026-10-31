import { afterEach, describe, expect, test } from "bun:test";
import type { Owner } from "@delacour/warden-core/types";
import { type TestContext, testContext } from "../testing";
import { lsCommand } from "./ls";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const agent: Owner = { kind: "agent", sessionId: "abc", cwd: "/w", repo: "salient", worktree: "cowrie@main" };

describe("warden ls", () => {
	test("table with alive/stale state", async () => {
		ctx = testContext([], { now: () => 600_000 });
		ctx.db.insertLease(
			{
				resource: { kind: "device", platform: "ios", id: "U1", name: "warden-iphone-17-1" },
				owner: agent,
				ttlMs: 3_600_000,
				label: "e2e",
			},
			480_000
		);
		ctx.db.insertLease({ resource: { kind: "port", port: 8091 }, owner: agent, ttlMs: 1_000 }, 0);
		expect(await lsCommand.run(ctx)).toBe(0);
		const text = ctx.stdout.join("\n");
		expect(text).toContain("RESOURCE");
		expect(text).toContain("ios warden-iphone-17-1 (U1)");
		expect(text).toContain("alive");
		expect(text).toContain("stale");
		expect(text).toContain("salient/cowrie@main");
		expect(text).toContain("2m");
		expect(text).toContain("port 8091");
	});

	test("--json", async () => {
		ctx = testContext(["--json"]);
		ctx.db.insertLease({ resource: { kind: "port", port: 1 }, owner: agent, ttlMs: 60_000 }, ctx.now());
		expect(await lsCommand.run(ctx)).toBe(0);
		const out = JSON.parse(ctx.stdout.join("\n"));
		expect(out.leases[0]).toMatchObject({ state: "alive", resource: { kind: "port", port: 1 } });
	});

	test("empty", async () => {
		ctx = testContext([]);
		expect(await lsCommand.run(ctx)).toBe(0);
		expect(ctx.stdout.join("\n")).toContain("no leases");
	});
});

describe("warden ls with remote leases", () => {
	test("shows stop_reason for a hosted device warden cloud stopped", async () => {
		const { fakeServer } = await import("../remote/api.testing");
		const server = fakeServer();
		ctx = testContext(["--json"], { fetch: server.fetch });
		ctx.env = { ...ctx.env, WARDEN_API_URL: "https://api.test", WARDEN_TOKEN: server.token };
		server.devices.set("rd1", {
			id: "rd1",
			platform: "ios",
			status: "stopped",
			stopReason: "credits_exhausted",
			idleTimeoutS: 300,
			startedAt: "2026-10-30T00:00:00.000Z",
		});
		ctx.db.insertLease(
			{ resource: { kind: "remote-device", platform: "ios", id: "rd1", name: "iphone" }, owner: agent, ttlMs: 60_000 },
			ctx.now()
		);
		expect(await lsCommand.run(ctx)).toBe(0);
		expect(JSON.parse(ctx.stdout.join("\n")).leases[0]).toMatchObject({ stopReason: "credits_exhausted" });

		ctx.stdout.length = 0;
		ctx.argv = [];
		expect(await lsCommand.run(ctx)).toBe(0);
		expect(ctx.stdout.join("\n")).toContain("stop_reason: credits_exhausted");
	});

	test("local-only leases never call warden cloud", async () => {
		const { fakeServer } = await import("../remote/api.testing");
		const server = fakeServer();
		ctx = testContext([], { fetch: server.fetch });
		ctx.db.insertLease({ resource: { kind: "port", port: 1 }, owner: agent, ttlMs: 60_000 }, ctx.now());
		expect(await lsCommand.run(ctx)).toBe(0);
		expect(server.calls).toEqual([]);
	});
});
