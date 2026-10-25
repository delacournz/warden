import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readState } from "../agent-ui/state";
import { type TestContext, testContext } from "../testing";
import {
	activeSessionFor,
	createSession,
	listSessions,
	readSession,
	type SessionDeps,
	sessionDir,
	stopSession,
	sweepSessions,
	updateSession,
} from "./session";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const T0 = Date.UTC(2026, 9, 24, 10, 0, 0);

type Fake = SessionDeps & { alive: Set<number>; commands: Map<number, string>; killed: Array<[number, string]> };

function fakeDeps(): Fake {
	const alive = new Set<number>();
	const commands = new Map<number, string>();
	const killed: Array<[number, string]> = [];
	let n = 0;
	return {
		alive,
		commands,
		killed,
		pidAlive: (pid) => alive.has(pid),
		command: (pid) => commands.get(pid),
		kill: (pid, signal) => {
			killed.push([pid, signal]);
			alive.delete(pid);
		},
		random: () => (++n).toString(16).padStart(6, "0"),
	};
}

function setup(): { c: TestContext; clock: { now: number } } {
	const clock = { now: T0 };
	ctx = testContext([], { now: () => clock.now });
	return { c: ctx, clock };
}

const device = { udid: "U1", platform: "ios", name: "warden-iphone-17-1" } as const;
const target = { udid: "U1", ownedByCaller: true };
const input = { device, target, maxDurationMs: 30_000 };
const second = {
	device: { ...device, udid: "U2" },
	target: { udid: "U2", ownedByCaller: true },
	maxDurationMs: 30_000,
};

function collector(pid: number) {
	return [{ kind: "collector" as const, pid, startedAtIso: "x", state: "running" as const }];
}

describe("createSession", () => {
	test("writes session.json under $WARDEN_HOME/perf/<id> and marks the device", () => {
		const { c } = setup();
		const made = createSession(c, fakeDeps(), input);
		if (!made.success) throw new Error(made.error.message);
		const s = made.data;
		expect(s.id).toBe("20261024-100000-000001");
		expect(s.status).toBe("running");
		expect(s.startedAt.wallMs).toBe(T0);
		expect(s.maxDurationMs).toBe(30_000);
		expect(sessionDir(c, s.id)).toBe(join(c.env.WARDEN_HOME ?? "", "perf", s.id));
		expect(JSON.parse(readFileSync(join(sessionDir(c, s.id), "session.json"), "utf8")).id).toBe(s.id);
		expect(readState(c, "U1").perf).toEqual({ sessionId: s.id });
		expect(readSession(c, s.id)).toEqual(s);
	});

	test("a second session on the same device is session_active, naming the first", () => {
		const { c } = setup();
		const deps = fakeDeps();
		const first = createSession(c, deps, input);
		const again = createSession(c, deps, {
			...input,
			target: { udid: "U1", holder: "agent x", ownedByCaller: false },
		});
		expect(again.success).toBe(false);
		if (again.success || !first.success) return;
		expect(again.error.code).toBe("session_active");
		expect(again.error.details).toMatchObject({ sessionId: first.data.id });
	});

	test("another device is independent", () => {
		const { c } = setup();
		const deps = fakeDeps();
		expect(createSession(c, deps, input).success).toBe(true);
		expect(createSession(c, deps, second).success).toBe(true);
	});

	test("a dead collector's session is swept (stale) and the device is free again", () => {
		const { c } = setup();
		const deps = fakeDeps();
		const first = createSession(c, deps, input);
		if (!first.success) throw new Error("first");
		updateSession(c, first.data.id, (s) => ({ ...s, capturers: collector(77) }));
		const next = createSession(c, deps, input);
		expect(next.success).toBe(true);
		expect(readSession(c, first.data.id)).toMatchObject({ status: "aborted", stopReason: "stale" });
	});
});

describe("updateSession / listSessions", () => {
	test("updates atomically and lists newest first", () => {
		const { c, clock } = setup();
		const deps = fakeDeps();
		const a = createSession(c, deps, input);
		clock.now += 60_000;
		const b = createSession(c, deps, second);
		if (!a.success || !b.success) throw new Error("create");
		const updated = updateSession(c, a.data.id, (s) => ({
			...s,
			marks: [...s.marks, { label: "x", wallMs: T0, atMs: 0 }],
		}));
		expect(updated?.marks).toHaveLength(1);
		expect(listSessions(c).map((s) => s.id)).toEqual([b.data.id, a.data.id]);
		expect(existsSync(join(sessionDir(c, a.data.id), "session.json.tmp"))).toBe(false);
	});

	test("an unknown or malformed id reads as undefined", () => {
		const { c } = setup();
		expect(readSession(c, "20261024-100000-ffffff")).toBeUndefined();
		expect(readSession(c, "../../etc")).toBeUndefined();
		expect(updateSession(c, "20261024-100000-ffffff", (s) => s)).toBeUndefined();
	});
});

describe("activeSessionFor", () => {
	test("returns the running session, nothing once it is over its cap", () => {
		const { c, clock } = setup();
		const deps = fakeDeps();
		const made = createSession(c, deps, input);
		if (!made.success) throw new Error("create");
		expect(activeSessionFor(c, deps, "U1")?.id).toBe(made.data.id);
		clock.now = T0 + 31_000;
		expect(activeSessionFor(c, deps, "U1")).toBeUndefined();
	});
});

describe("stopSession (safeToSignal)", () => {
	function withCollector(c: TestContext, deps: Fake, pid: number, command: (id: string) => string | undefined) {
		const made = createSession(c, deps, input);
		if (!made.success) throw new Error("create");
		updateSession(c, made.data.id, (s) => ({ ...s, capturers: collector(pid) }));
		deps.alive.add(pid);
		const text = command(made.data.id);
		if (text !== undefined) deps.commands.set(pid, text);
		return made.data.id;
	}

	test("signals a collector whose command line still carries the session", () => {
		const { c } = setup();
		const deps = fakeDeps();
		const id = withCollector(c, deps, 4242, (sid) => `bun warden perf-collect --session ${sid}`);
		const stopped = stopSession(c, deps, id, "user");
		expect(deps.killed).toEqual([[4242, "SIGTERM"]]);
		expect(stopped).toMatchObject({ status: "stopped", stopReason: "user" });
		expect(readState(c, "U1").perf).toBeUndefined();
	});

	test("never signals a reused pid (a different program)", () => {
		const { c } = setup();
		const deps = fakeDeps();
		const id = withCollector(c, deps, 4242, () => "/usr/bin/vim notes.txt");
		stopSession(c, deps, id, "user");
		expect(deps.killed).toEqual([]);
		expect(readSession(c, id)).toMatchObject({ status: "stopped" });
	});

	test("never signals a pid whose command line is unreadable", () => {
		const { c } = setup();
		const deps = fakeDeps();
		const id = withCollector(c, deps, 4242, () => undefined);
		stopSession(c, deps, id, "user");
		expect(deps.killed).toEqual([]);
	});
});

describe("sweepSessions (cap + stale)", () => {
	test("stops a session over its cap with max-duration and signals only a verified collector", () => {
		const { c, clock } = setup();
		const deps = fakeDeps();
		const made = createSession(c, deps, { ...input, maxDurationMs: 10_000 });
		if (!made.success) throw new Error("create");
		updateSession(c, made.data.id, (s) => ({ ...s, capturers: collector(9) }));
		deps.alive.add(9);
		deps.commands.set(9, `warden perf-collect --session ${made.data.id}`);
		clock.now = T0 + 10_000;
		expect(sweepSessions(c, deps)).toEqual([{ id: made.data.id, reason: "max-duration" }]);
		expect(deps.killed).toEqual([[9, "SIGTERM"]]);
		expect(readSession(c, made.data.id)).toMatchObject({
			status: "stopped",
			stopReason: "max-duration",
			stoppedAt: clock.now,
		});
		expect(readState(c, "U1").perf).toBeUndefined();
	});

	test("marks a dead collector's session stale and leaves live ones alone", () => {
		const { c } = setup();
		const deps = fakeDeps();
		const dead = createSession(c, deps, input);
		const live = createSession(c, deps, second);
		if (!dead.success || !live.success) throw new Error("create");
		updateSession(c, dead.data.id, (s) => ({ ...s, capturers: collector(5) }));
		expect(sweepSessions(c, deps)).toEqual([{ id: dead.data.id, reason: "stale" }]);
		expect(readSession(c, live.data.id)?.status).toBe("running");
	});
});
