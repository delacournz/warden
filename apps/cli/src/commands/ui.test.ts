import { afterEach, describe, expect, test } from "bun:test";
import type { Owner } from "@delacour/warden-core/types";
import { blockMessage } from "../device-lease";
import { handlePreToolUse } from "../hooks/claude-pretool";
import { fakeSimctl, OWNER_ENV, wardenSim } from "../simctl.testing";
import { type TestContext, testContext } from "../testing";
import { uiCommand } from "./ui";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const other: Owner = { kind: "agent", sessionId: "other", cwd: "/w", repo: "salient", worktree: "cowrie@main" };
const mine: Owner = { kind: "agent", sessionId: "me", cwd: "/w" };
const UDID = "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D";
const UDID2 = "1A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D";

function setup(argv: string[], env: Record<string, string> = {}, over: Partial<TestContext> = {}): TestContext {
	ctx = testContext(argv, over);
	ctx.env = { ...ctx.env, ...OWNER_ENV, ...env };
	return ctx;
}

function lease(c: TestContext, id: string, owner: Owner, extra: { ttlMs?: number; at?: number } = {}) {
	return c.db.insertLease(
		{
			resource: { kind: "device", platform: "ios", id, name: `sim-${id.slice(0, 2)}` },
			owner,
			ttlMs: extra.ttlMs ?? 600_000,
		},
		extra.at ?? c.now()
	);
}

function json(c: TestContext) {
	expect(c.stdout).toHaveLength(1);
	return JSON.parse(c.stdout[0] ?? "");
}

describe("warden ui status", () => {
	test("foreign live lease: exit 2 with the hook's block message", async () => {
		const c = setup(["status", "--udid", UDID]);
		lease(c, UDID, other);
		expect(await uiCommand.run(c)).toBe(2);
		expect(c.stderr.join("\n")).toContain(blockMessage(UDID, "ios", other));
		expect(c.stdout).toEqual([]);
	});

	test("foreign live lease with --json: one failure document, even with --claim", async () => {
		const c = setup(["status", "--udid", UDID, "--claim", "--json"]);
		lease(c, UDID, other);
		expect(await uiCommand.run(c)).toBe(2);
		expect(json(c)).toEqual({
			ok: false,
			command: "status",
			error: { code: "device_foreign", message: blockMessage(UDID, "ios", other) },
		});
		expect(c.stderr).toEqual([]);
	});

	test("no lease and no --claim: exit 2 with the claim hint", async () => {
		const c = setup(["status", "--udid", UDID]);
		expect(await uiCommand.run(c)).toBe(2);
		expect(c.stderr.join("\n")).toContain("is not leased");
		expect(c.stderr.join("\n")).toContain("--claim");
		expect(c.db.listLeases()).toHaveLength(0);
	});

	test("nothing named, nothing held: exit 2 `no device leased — run warden claim ios --json, or add --claim`", async () => {
		const c = setup(["status"]);
		expect(await uiCommand.run(c)).toBe(2);
		expect(c.stderr.join("\n")).toContain("no device leased — run warden claim ios --json, or add --claim");
	});

	test("--claim leases with a `warden ui` label; the next call heartbeats it", async () => {
		const first = setup(["status", "--udid", UDID, "--claim", "--json"]);
		expect(await uiCommand.run(first)).toBe(0);
		expect(json(first)).toMatchObject({ ok: true, command: "status", device: { udid: UDID, platform: "ios" } });
		expect(json(first).result.lease.action).toBe("leased");
		const [created] = first.db.listLeases();
		expect(created).toMatchObject({ label: "warden ui", owner: { kind: "agent", sessionId: "me" } });

		first.now = () => 1_060_000;
		first.argv = ["status", "--udid", UDID, "--json"];
		first.stdout.length = 0;
		expect(await uiCommand.run(first)).toBe(0);
		expect(json(first).result.lease.action).toBe("own");
		expect(first.db.getLease(created?.id ?? "")?.heartbeatAt).toBe(1_060_000);
	});

	test("--claim reclaims a stale foreign lease", async () => {
		const c = setup(["status", "--udid", UDID, "--claim"]);
		lease(c, UDID, other, { ttlMs: 1000, at: 0 });
		expect(await uiCommand.run(c)).toBe(0);
		expect(c.db.listLeases().map((l) => l.owner)).toMatchObject([{ kind: "agent", sessionId: "me" }]);
	});

	test("stale lease without --claim: exit 2", async () => {
		const c = setup(["status", "--udid", UDID]);
		lease(c, UDID, other, { ttlMs: 1000, at: 0 });
		expect(await uiCommand.run(c)).toBe(2);
	});

	test("WARDEN_UDID resolves the device without flags", async () => {
		const c = setup(["status", "--json"], { WARDEN_UDID: UDID });
		lease(c, UDID, mine);
		expect(await uiCommand.run(c)).toBe(0);
		expect(json(c).device.udid).toBe(UDID);
		expect(json(c).result.lease.source).toBe("WARDEN_UDID");
	});

	test("WARDEN_UDIDS with exactly one entry resolves; with two it falls through to the caller's leases", async () => {
		const c = setup(["status", "--json"], { WARDEN_UDIDS: UDID });
		lease(c, UDID, mine);
		expect(await uiCommand.run(c)).toBe(0);
		expect(json(c).result.lease.source).toBe("WARDEN_UDIDS");

		c.argv = ["status", "--json"];
		c.env = { ...c.env, WARDEN_UDIDS: `${UDID},${UDID2}` };
		c.stdout.length = 0;
		expect(await uiCommand.run(c)).toBe(0);
		expect(json(c).result.lease.source).toBe("lease");
	});

	test("the caller's single device lease is used; several → exit 2 listing them", async () => {
		const c = setup(["status"]);
		lease(c, UDID, mine);
		expect(await uiCommand.run(c)).toBe(0);
		expect(c.stdout.join("\n")).toContain(UDID);

		lease(c, UDID2, mine);
		c.stdout.length = 0;
		c.stderr.length = 0;
		expect(await uiCommand.run(c)).toBe(2);
		expect(c.stderr.join("\n")).toContain(UDID);
		expect(c.stderr.join("\n")).toContain(UDID2);
	});

	test("--lease selects the device behind a lease id; unknown id → exit 2", async () => {
		const c = setup(["status", "--json"]);
		const l = lease(c, UDID, mine);
		lease(c, UDID2, mine);
		c.argv = ["status", "--lease", l.id, "--json"];
		expect(await uiCommand.run(c)).toBe(0);
		expect(json(c).device.udid).toBe(UDID);

		c.argv = ["status", "--lease", "nope", "--json"];
		c.stdout.length = 0;
		expect(await uiCommand.run(c)).toBe(2);
		expect(json(c).error.code).toBe("lease_not_found");
	});

	test("--serial is an Android device", async () => {
		const c = setup(["status", "--serial", "emulator-5554", "--claim", "--json"]);
		expect(await uiCommand.run(c)).toBe(0);
		expect(json(c).device).toMatchObject({ udid: "emulator-5554", platform: "android" });
	});

	test("--claim with nothing named claims a device via warden claim (--profile/--runtime accepted)", async () => {
		const calls: string[][] = [];
		const c = setup(
			["status", "--claim", "--profile", "iphone-17", "--runtime", "latest", "--json"],
			{},
			{
				exec: fakeSimctl([wardenSim(1), wardenSim(2, "Booted")], calls),
			}
		);
		expect(await uiCommand.run(c)).toBe(0);
		expect(json(c)).toMatchObject({ ok: true, device: { udid: "U2", platform: "ios" } });
		expect(json(c).result.lease.action).toBe("claimed");
		expect(c.db.listLeases()[0]).toMatchObject({ label: "warden ui" });
		expect(calls.some((x) => x.join(" ").includes("simctl list devices"))).toBe(true);
	});

	test("--json success prints exactly one JSON document; text mode prints no JSON", async () => {
		const c = setup(["status", "--udid", UDID, "--claim", "--json"]);
		expect(await uiCommand.run(c)).toBe(0);
		const doc = json(c);
		expect(doc).toMatchObject({ ok: true, command: "status", durationMs: 0 });
		expect(doc.result).toMatchObject({ helper: "not started", recording: "none" });

		const t = setup(["status", "--udid", UDID]);
		lease(t, UDID, mine);
		expect(await uiCommand.run(t)).toBe(0);
		const text = t.stdout.join("\n");
		expect(text).toContain("helper    not started");
		expect(text).toContain("recording none");
	});

	test("--timeout must be a positive integer; accepted otherwise", async () => {
		const bad = setup(["status", "--udid", UDID, "--timeout", "abc", "--json"]);
		expect(await uiCommand.run(bad)).toBe(1);
		expect(json(bad).error.code).toBe("usage");

		const good = setup(["status", "--udid", UDID, "--claim", "--timeout", "250", "--no-record"]);
		expect(await uiCommand.run(good)).toBe(0);
	});

	test("an unexpected throw is still one --json document (exit 1)", async () => {
		const c = setup(["status", "--udid", UDID, "--json"]);
		c.store = () => {
			throw new Error("db gone");
		};
		expect(await uiCommand.run(c)).toBe(1);
		expect(json(c)).toMatchObject({ ok: false, error: { code: "failed", message: "db gone" } });
	});
});

describe("ensureCallerLease is shared by the hook and `warden ui`", () => {
	test("a lease the hook created is the caller's lease in `ui` (same session), and vice versa", async () => {
		const c = setup(["status", "--udid", UDID, "--json"]);
		const hookDeps = {
			store: () => c.db,
			now: () => c.now(),
			pidAlive: () => false,
			gitInfo: () => undefined,
			deviceState: async () => undefined,
			shutdown: async () => ({ shutdown: [], notes: [] }),
			maybeGc: () => {},
			endInBackground: () => false,
		};
		const hook = (sessionId: string) =>
			handlePreToolUse(
				{ session_id: sessionId, cwd: "/w", tool_name: "mcp__argent__gesture-tap", tool_input: { udid: UDID } },
				hookDeps
			);
		expect((await hook("me")).exitCode).toBe(0);
		expect(await uiCommand.run(c)).toBe(0);
		expect(json(c).result.lease.action).toBe("own");

		c.argv = ["status", "--udid", UDID, "--json"];
		const blocked = await hook("other");
		expect(blocked.exitCode).toBe(2);
		expect(blocked.stderr).toBe(blockMessage(UDID, "ios", mine));
	});
});
