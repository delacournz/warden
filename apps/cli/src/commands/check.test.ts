import { afterEach, describe, expect, test } from "bun:test";
import type { Owner } from "@warden/core/types";
import { OWNER_ENV } from "../simctl.testing";
import { type TestContext, testContext } from "../testing";
import { checkCommand } from "./check";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const other: Owner = { kind: "agent", sessionId: "other", cwd: "/w", repo: "salient", worktree: "cowrie@main" };

function setup(argv: string[]): TestContext {
	ctx = testContext(argv);
	ctx.env = { ...ctx.env, ...OWNER_ENV };
	ctx.db.insertLease(
		{
			resource: { kind: "device", platform: "ios", id: "U1", name: "warden-iphone-17-1" },
			owner: other,
			ttlMs: 60_000,
		},
		ctx.now()
	);
	return ctx;
}

describe("warden check", () => {
	test("free device → 0", async () => {
		const c = setup(["--udid", "U9", "--json"]);
		expect(await checkCommand.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({ udid: "U9", free: true, mine: false });
	});

	test("leased by the given session → 0", async () => {
		const c = setup(["--udid", "U1", "--session", "other"]);
		expect(await checkCommand.run(c)).toBe(0);
	});

	test("leased by someone else → 2 with owner message", async () => {
		const c = setup(["--udid", "U1"]);
		expect(await checkCommand.run(c)).toBe(2);
		expect(c.stderr.join("\n")).toBe("device U1 leased by agent other (salient/cowrie@main)");
	});

	test("stale lease counts as free", async () => {
		const c = setup(["--udid", "U1"]);
		c.now = () => 10_000_000;
		expect(await checkCommand.run(c)).toBe(0);
	});

	test("missing --udid → 1", async () => {
		const c = setup([]);
		expect(await checkCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("--udid");
	});
});
