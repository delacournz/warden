import { afterEach, describe, expect, test } from "bun:test";
import { type TestContext, testContext } from "../testing";
import { perfMark } from "./mark";
import { createSession, readSession } from "./session";
import { asMe, fakePerfDeps } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const T0 = 5_000_000;
const sim = { platform: "ios", id: "U1", name: "warden-iphone-17-1" } as const;

function setup() {
	const clock = { now: T0 };
	const c = testContext([], { now: () => clock.now });
	ctx = c;
	asMe(c);
	c.db.recordDevice({ platform: "ios", id: "U1", name: sim.name }, T0);
	return { c, clock, deps: fakePerfDeps([sim]) };
}

const start = (c: TestContext, deps: ReturnType<typeof fakePerfDeps>) =>
	createSession(c, deps.session, {
		device: { udid: "U1", platform: "ios", name: sim.name },
		target: { udid: "U1", ownedByCaller: false },
		maxDurationMs: 30_000,
	});

describe("warden perf mark", () => {
	test("appends a mark with its offset from the session start", async () => {
		const { c, clock, deps } = setup();
		const made = start(c, deps);
		if (!made.success) throw new Error("create");
		clock.now = T0 + 3_200;
		expect(await perfMark(c, deps, ["scroll", "feed"], { json: true })).toBe(0);
		const doc = JSON.parse(c.stdout.join("\n"));
		expect(doc).toMatchObject({
			ok: true,
			command: "perf mark",
			result: { sessionId: made.data.id, label: "scroll feed", atMs: 3200 },
		});
		expect(readSession(c, made.data.id)?.marks).toEqual([{ label: "scroll feed", wallMs: T0 + 3_200, atMs: 3_200 }]);
	});

	test("text mode says what was marked", async () => {
		const { c, clock, deps } = setup();
		start(c, deps);
		clock.now = T0 + 1_500;
		expect(await perfMark(c, deps, ["tap"], {})).toBe(0);
		expect(c.stdout.join("\n")).toContain('marked "tap" at +1.5s');
	});

	test("no active session: session_not_found, exit 1", async () => {
		const { c, deps } = setup();
		expect(await perfMark(c, deps, ["x"], { json: true })).toBe(1);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({ ok: false, error: { code: "session_not_found" } });
	});

	test("a session past its cap is not active", async () => {
		const { c, clock, deps } = setup();
		start(c, deps);
		clock.now = T0 + 31_000;
		expect(await perfMark(c, deps, ["late"], { json: true })).toBe(1);
	});

	test("an empty label is a usage error", async () => {
		const { c, deps } = setup();
		start(c, deps);
		expect(await perfMark(c, deps, ["  "], { json: true })).toBe(1);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({ ok: false, error: { code: "usage" } });
	});

	test("marking never takes a lease on the device", async () => {
		const { c, deps } = setup();
		start(c, deps);
		await perfMark(c, deps, ["x"], { json: true });
		expect(c.db.listLeases()).toEqual([]);
	});
});
