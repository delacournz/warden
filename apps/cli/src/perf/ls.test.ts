import { afterEach, describe, expect, test } from "bun:test";
import type { Owner } from "@delacour/warden-core/types";
import { type TestContext, testContext } from "../testing";
import { perfLs } from "./ls";
import { createSession, stopSession, updateSession } from "./session";
import { asMe, fakePerfDeps } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const T0 = Date.UTC(2026, 9, 24, 10, 0, 0);
const sim = (n: number) => ({ platform: "ios", id: `U${n}`, name: `warden-iphone-17-${n}` }) as const;
const other: Owner = { kind: "agent", sessionId: "other", cwd: "/" };

function setup() {
	const clock = { now: T0 };
	const c = testContext([], { now: () => clock.now });
	ctx = c;
	asMe(c);
	for (const n of [1, 2]) c.db.recordDevice({ platform: "ios", id: `U${n}`, name: sim(n).name }, T0);
	return { c, clock, deps: fakePerfDeps([sim(1), sim(2)], { U1: "com.acme.shop" }) };
}

const open = (c: TestContext, deps: ReturnType<typeof fakePerfDeps>, n: number, app?: string) =>
	createSession(c, deps.session, {
		device: { udid: `U${n}`, platform: "ios", name: sim(n).name },
		target: { udid: `U${n}`, ownedByCaller: false },
		...(app ? { app: { id: app, source: "flag" as const } } : {}),
		maxDurationMs: 30_000,
	});

describe("warden perf ls", () => {
	test("no sessions", async () => {
		const { c, deps } = setup();
		c.argv = [];
		expect(await perfLs(c, deps, {})).toBe(0);
		expect(c.stdout.join("\n")).toContain("no perf sessions");
	});

	test("lists sessions newest first with device, app, status and mark count", async () => {
		const { c, clock, deps } = setup();
		const a = open(c, deps, 1, "com.acme.shop");
		clock.now += 60_000;
		const b = open(c, deps, 2);
		if (!a.success || !b.success) throw new Error("create");
		updateSession(c, a.data.id, (s) => ({ ...s, marks: [{ label: "x", wallMs: T0, atMs: 0 }] }));
		stopSession(c, deps.session, a.data.id, "user");
		expect(await perfLs(c, deps, { json: true })).toBe(0);
		const doc = JSON.parse(c.stdout.join("\n"));
		expect(doc.sessions.map((s: { id: string }) => s.id)).toEqual([b.data.id, a.data.id]);
		expect(doc.sessions[1]).toMatchObject({ device: "U1", app: "com.acme.shop", status: "stopped", marks: 1 });
		expect(doc.sessions[0]).toMatchObject({ status: "running" });
	});

	test("a running session past its cap shows as overdue", async () => {
		const { c, clock, deps } = setup();
		open(c, deps, 1);
		clock.now += 45_000;
		await perfLs(c, deps, { json: true });
		expect(JSON.parse(c.stdout.join("\n")).sessions[0].status).toBe("overdue");
	});

	test("--device filters by udid", async () => {
		const { c, deps } = setup();
		open(c, deps, 1);
		open(c, deps, 2);
		await perfLs(c, deps, { json: true, device: "U2" });
		const doc = JSON.parse(c.stdout.join("\n"));
		expect(doc.sessions).toHaveLength(1);
		expect(doc.sessions[0].device).toBe("U2");
	});

	test("--devices lists warden's booted devices with holder and foreground app", async () => {
		const { c, deps } = setup();
		c.db.insertLease(
			{
				resource: { kind: "device", platform: "ios", id: "U2", name: sim(2).name },
				owner: other,
				ttlMs: 60_000,
				label: "e2e",
			},
			c.now()
		);
		expect(await perfLs(c, deps, { json: true, devices: true })).toBe(0);
		const doc = JSON.parse(c.stdout.join("\n"));
		expect(doc.devices).toEqual([
			{ udid: "U1", platform: "ios", name: "warden-iphone-17-1", app: "com.acme.shop" },
			{ udid: "U2", platform: "ios", name: "warden-iphone-17-2", holder: expect.stringContaining("other") },
		]);
		expect(doc.sessions).toBeUndefined();
	});
});
