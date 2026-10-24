import { afterEach, describe, expect, test } from "bun:test";
import { createSession, readSession } from "../perf/session";
import { fakePerfDeps } from "../perf/testing";
import { type TestContext, testContext } from "../testing";
import { createPerfCollectCommand } from "./perf-collect";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const T0 = 9_000_000;
const sim = { platform: "ios", id: "U1", name: "warden-iphone-17-1" } as const;

function setup(maxDurationMs: number) {
	const clock = { now: T0 };
	const c = testContext([], { now: () => clock.now });
	ctx = c;
	const deps = fakePerfDeps([sim]);
	const made = createSession(c, deps.session, {
		device: { udid: "U1", platform: "ios", name: sim.name },
		target: { udid: "U1", ownedByCaller: true },
		maxDurationMs,
	});
	if (!made.success) throw new Error("create");
	const sleep = async (ms: number) => {
		clock.now += ms;
	};
	return { c, clock, deps, id: made.data.id, sleep };
}

describe("warden perf-collect", () => {
	test("records itself as the collector and stops the session at its cap", async () => {
		const { c, deps, id, sleep } = setup(3_000);
		c.argv = ["--session", id];
		const command = createPerfCollectCommand({ sleep, session: deps.session });
		expect(await command.run(c)).toBe(0);
		const s = readSession(c, id);
		expect(s).toMatchObject({ status: "stopped", stopReason: "max-duration" });
		expect(s?.capturers).toEqual([
			{ kind: "collector", pid: process.pid, startedAtIso: new Date(T0).toISOString(), state: "stopped" },
		]);
	});

	test("a missing or malformed session is exit 1", async () => {
		const { c, deps, sleep } = setup(3_000);
		const command = createPerfCollectCommand({ sleep, session: deps.session });
		c.argv = ["--session", "nope"];
		expect(await command.run(c)).toBe(1);
		c.argv = ["--session", "20000101-000000-abcdef"];
		expect(await command.run(c)).toBe(1);
		c.argv = [];
		expect(await command.run(c)).toBe(1);
	});

	test("is hidden from --help", () => {
		expect(createPerfCollectCommand().hidden).toBe(true);
	});
});
