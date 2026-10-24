import { afterEach, describe, expect, test } from "bun:test";
import type { Owner } from "@delacour/warden-core/types";
import { snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import { blockMessage } from "../device-lease";
import { fakeSimctl, OWNER_ENV, wardenSim } from "../simctl.testing";
import { type TestContext, testContext } from "../testing";
import { uiCommand } from "./ui";
import { cleanupHarnesses, doc, UDID as HARNESS_UDID, harness, LOGIN } from "./ui.testing";

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
		expect(doc.result).toMatchObject({ helper: { running: false, pid: null, socket: null }, recording: "none" });

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

describe("warden ui on a device a live warden process holds (refuse unless --force)", () => {
	afterEach(cleanupHarnesses);
	const RUN = { pid: 4242, label: "warden e2e" };
	const busy = `device sim (${HARNESS_UDID}) is in use by agent me (pid 4242, warden e2e); re-run with --force to drive it anyway`;

	test("live run pid on the caller's own lease: exit 2 naming owner, pid and label; no driver opened", async () => {
		const h = harness(() => snap(), { lease: RUN, pidAlive: (pid) => pid === 4242 });
		expect(await h.run("snapshot")).toBe(2);
		expect(h.c.stderr.join("\n")).toContain(busy);
		expect(h.opens.count).toBe(0);
		expect(h.driver.calls).toEqual([]);
	});

	test("--json: one failure document with code device_busy", async () => {
		const h = harness(() => snap(), { lease: RUN, pidAlive: () => true });
		expect(await h.run("press", "id=sign-in-submit", "--json")).toBe(2);
		expect(doc(h.c)).toEqual({ ok: false, command: "press", error: { code: "device_busy", message: busy } });
		expect(h.opens.count).toBe(0);
	});

	test("every driving subcommand refuses (screen screenshot/video, type, open, close, gesture swipe)", async () => {
		// `screenshot` and `video` live under the `screen` group, swipes under `gesture` (WDN-GES, #34)
		for (const argv of [
			["screen", "screenshot"],
			["screen", "video", "start"],
			["type", "hi"],
			["open", "com.x.y"],
			["close"],
			["gesture", "swipe", "up"],
		]) {
			const h = harness(() => snap(), { lease: RUN, pidAlive: () => true });
			expect(await h.run(...argv)).toBe(2);
			expect(h.opens.count).toBe(0);
		}
	});

	test("status still reports (it opens no driver)", async () => {
		const h = harness(() => snap(), { lease: RUN, pidAlive: () => true });
		expect(await h.run("status")).toBe(0);
	});

	test("dead run pid: proceeds", async () => {
		const h = harness(() => snap(), { lease: RUN, pidAlive: () => false });
		expect(await h.run("snapshot")).toBe(0);
		expect(h.opens.count).toBe(1);
	});

	test("same owner, no holder pid (a plain claim): proceeds", async () => {
		const h = harness(() => snap(), { pidAlive: () => true });
		expect(await h.run("snapshot")).toBe(0);
		expect(h.opens.count).toBe(1);
	});

	test("--force: proceeds as before", async () => {
		const h = harness(() => snap(), { lease: RUN, pidAlive: () => true });
		expect(await h.run("snapshot", "--force")).toBe(0);
		expect(h.opens.count).toBe(1);
	});

	test("--force does not bypass another owner's live lease", async () => {
		const c = setup(["snapshot", "--udid", UDID, "--force"]);
		lease(c, UDID, other);
		expect(await uiCommand.run(c)).toBe(2);
		expect(c.stderr.join("\n")).toContain(blockMessage(UDID, "ios", other));
	});

	const snap = () => snapshotOf(LOGIN);
});

describe("warden ui on the caller's own `warden dev` device (shared lease: attach, don't steal)", () => {
	afterEach(cleanupHarnesses);
	const DEV = { pid: 4242, shared: true };
	const leaseId = (h: ReturnType<typeof harness>) => h.c.db.listLeases()[0]?.id ?? "";

	test("snapshot proceeds without --force; --json carries attachedTo: <dev lease id>", async () => {
		const h = harness(() => snap(), { lease: DEV, pidAlive: (pid) => pid === 4242 });
		const id = leaseId(h);
		expect(await h.run("snapshot", "--json")).toBe(0);
		expect(doc(h.c)).toMatchObject({ ok: true, command: "snapshot", attachedTo: id });
		expect(h.opens.count).toBe(1);
	});

	test("open says it is sharing the dev lease", async () => {
		const h = harness(() => snap(), { lease: DEV, pidAlive: () => true });
		expect(await h.run("open", "com.x.y")).toBe(0);
		expect(h.c.stdout.join("\n")).toContain(`sharing ${leaseId(h)} with warden dev (pid 4242)`);
	});

	test("status reports action attached", async () => {
		const h = harness(() => snap(), { lease: DEV, pidAlive: () => true });
		expect(await h.run("status", "--json")).toBe(0);
		expect(doc(h.c).result.lease.action).toBe("attached");
	});

	test("close --release keeps the dev lease (warden dev owns it) and says so", async () => {
		const h = harness(() => snap(), { lease: DEV, pidAlive: () => true });
		const id = leaseId(h);
		expect(await h.run("close", "--release", "--json")).toBe(0);
		const out = doc(h.c);
		expect(out.attachedTo).toBe(id);
		expect(out.result.released).toBe(false);
		expect(out.warnings.join("\n")).toContain(`not released: ${id} belongs to warden dev (pid 4242)`);
		expect(h.c.db.getLease(id)).toBeDefined();
	});

	test("a running e2e suite (not shared) is still refused", async () => {
		const h = harness(() => snap(), { lease: { pid: 4242, label: "warden e2e" }, pidAlive: () => true });
		expect(await h.run("snapshot")).toBe(2);
		expect(h.opens.count).toBe(0);
	});

	test("dev holder gone: an ordinary own lease again (no attachedTo, close --release releases)", async () => {
		const h = harness(() => snap(), { lease: DEV, pidAlive: () => false });
		const id = leaseId(h);
		expect(await h.run("close", "--release", "--json")).toBe(0);
		const out = doc(h.c);
		expect(out.attachedTo).toBeUndefined();
		expect(out.result.released).toBe(true);
		expect(h.c.db.getLease(id)).toBeUndefined();
	});

	const snap = () => snapshotOf(LOGIN);
});

describe("warden ui picks the live `warden dev` device among several held", () => {
	test("no device named: the single live shared lease wins over a plain claim", async () => {
		const c = setup(["status", "--json"]);
		lease(c, UDID, mine);
		const dev = c.db.insertLease(
			{
				resource: { kind: "device", platform: "ios", id: UDID2, name: "dev-sim" },
				owner: mine,
				ttlMs: 600_000,
				pid: process.pid,
				label: "warden dev",
				shared: true,
			},
			c.now()
		);
		expect(await uiCommand.run(c)).toBe(0);
		expect(json(c)).toMatchObject({ ok: true, device: { udid: UDID2 }, attachedTo: dev.id });
	});

	test("two plain claims: still ambiguous", async () => {
		const c = setup(["status", "--json"]);
		lease(c, UDID, mine);
		lease(c, UDID2, mine);
		expect(await uiCommand.run(c)).toBe(2);
		expect(json(c).error.code).toBe("ambiguous_device");
	});
});
