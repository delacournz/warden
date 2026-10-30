import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { el, fakeDriver as scriptedDriver, snapshotOf } from "./driver/driver.testing";
import type { Driver, DriverResult } from "./driver/driver.types";
import { canObserve } from "./driver/observation-cache";
import type { E2eEnv } from "./env";
import { E2eError } from "./errors";
import type { AttemptContext } from "./runner/fixtures.types";
import type { TraceEvent, TraceWriter } from "./runner/trace";
import {
	type AttemptBinding,
	attemptSession,
	createSession,
	devtoolsTarget,
	getSession,
	resetSession,
	setDefaultDriverFactory,
} from "./session";

const dirs: string[] = [];
const tmp = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "wdn-session-"));
	dirs.push(dir);
	return dir;
};

afterEach(async () => {
	await resetSession();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const envIn = (out: string): E2eEnv => ({
	udid: "U1",
	platform: "ios",
	bundleId: "com.acme.app",
	launchArgs: [],
	out,
	timeoutMs: 120_000,
	actionTimeoutMs: 30_000,
	assertionTimeoutMs: 5_000,
	logTimestamps: false,
});

/** The smallest Driver the session needs: it only ever calls `close`. */
function fakeDriver(): { driver: Driver; closed: () => number } {
	let closes = 0;
	const driver = {
		platform: "ios",
		id: "U1",
		async close() {
			closes += 1;
		},
	} as unknown as Driver;
	return { driver, closed: () => closes };
}

function factory() {
	const fake = fakeDriver();
	const calls: E2eEnv[] = [];
	const open = async (env: E2eEnv): DriverResult<Driver> => {
		calls.push(env);
		return { success: true, data: fake.driver };
	};
	return { open, calls, fake };
}

describe("Session biometrics", () => {
	const scripted = (platform: "ios" | "android", biometrics: boolean) => {
		const fake = scriptedDriver({ platform, screens: [] });
		const session = createSession({
			env: { ...envIn(tmp()), platform, ...(biometrics ? { biometrics: true } : {}) },
			driverFactory: async () => ({ success: true, data: fake }),
			exitHook: false,
		});
		return { fake, session };
	};

	test("a biometrics iOS session enrolls when the driver opens", async () => {
		const { fake, session } = scripted("ios", true);
		await session.driver();
		await session.driver();
		expect(fake.callsOf("biometrics")).toEqual([{ method: "biometrics", op: "enroll" }]);
	});

	test("an enroll whose read-back is not enrolled is applied again", async () => {
		const { fake, session } = scripted("ios", true);
		let reads = 0;
		const real = fake.biometrics.bind(fake);
		fake.biometrics = async (op) => {
			const state = await real(op);
			reads += 1;
			return state.success && reads < 2 ? { success: true, data: { ...state.data, enrolled: false } } : state;
		};
		await session.driver();
		expect(reads).toBe(2);
	});

	test("plain iOS and Android sessions do not", async () => {
		for (const [platform, bio] of [
			["ios", false],
			["android", true],
		] as const) {
			const { fake, session } = scripted(platform, bio);
			await session.driver();
			expect(fake.callsOf("biometrics")).toEqual([]);
		}
	});
});

describe("Session", () => {
	test("driver factory is not called until the first driver()", async () => {
		const f = factory();
		const session = createSession({ env: envIn(tmp()), driverFactory: f.open, exitHook: false });
		expect(f.calls).toHaveLength(0);
		await session.driver();
		expect(f.calls).toHaveLength(1);
	});

	test("driver is opened once and shared, even concurrently", async () => {
		const f = factory();
		const env = envIn(tmp());
		const session = createSession({ env, driverFactory: f.open, exitHook: false });
		const [a, b] = await Promise.all([session.driver(), session.driver()]);
		const c = await session.driver();
		expect(a.id).toBe(f.fake.driver.id);
		expect(b).toBe(a);
		expect(c).toBe(a);
		expect(session.peekDriver()).toBe(a);
		expect(f.calls).toEqual([env]);
	});

	test("a failed open throws E2eError DRIVER and can be retried", async () => {
		let attempts = 0;
		const fake = fakeDriver();
		const session = createSession({
			env: envIn(tmp()),
			exitHook: false,
			driverFactory: async () => {
				attempts += 1;
				if (attempts === 1) {
					return { success: false, error: { code: "E_NOT_BOOTED", message: "boot it", retryable: false } };
				}
				return { success: true, data: fake.driver };
			},
		});
		const error = await session.driver().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(E2eError);
		expect(error).toMatchObject({ code: "DRIVER", message: "E_NOT_BOOTED: boot it" });
		expect((await session.driver()).id).toBe(fake.driver.id);
	});

	test("a throwing factory is also a DRIVER error", async () => {
		const session = createSession({
			env: envIn(tmp()),
			exitHook: false,
			driverFactory: async () => {
				throw new Error("spawn failed");
			},
		});
		await expect(session.driver()).rejects.toMatchObject({ code: "DRIVER", message: "spawn failed" });
	});

	test("out is absolute and created; results append under it", async () => {
		const out = join(tmp(), "nested", "out");
		const session = createSession({ env: envIn(out), driverFactory: factory().open, exitHook: false });
		expect(session.out).toBe(out);
		expect(existsSync(out)).toBe(true);
		session.results.append({
			file: "/a.e2e.ts",
			title: ["t"],
			status: "passed",
			durationMs: 1,
			startedAt: 1,
			device: { udid: "U1", platform: "ios" },
		});
		expect(existsSync(join(out, "results.jsonl"))).toBe(true);
	});

	test("close() closes an opened driver once and is idempotent", async () => {
		const f = factory();
		const session = createSession({ env: envIn(tmp()), driverFactory: f.open, exitHook: false });
		await session.driver();
		await Promise.all([session.close(), session.close()]);
		await session.close();
		expect(f.fake.closed()).toBe(1);
		await expect(session.driver()).rejects.toMatchObject({ code: "SESSION" });
	});

	test("close() without ever opening the driver never calls the factory", async () => {
		const f = factory();
		const session = createSession({ env: envIn(tmp()), driverFactory: f.open, exitHook: false });
		await session.close();
		expect(f.calls).toHaveLength(0);
		expect(f.fake.closed()).toBe(0);
	});

	test("registers an exit hook and removes it on close", async () => {
		const before = process.listenerCount("exit");
		const session = createSession({ env: envIn(tmp()), driverFactory: factory().open });
		expect(process.listenerCount("exit")).toBe(before + 1);
		await session.close();
		expect(process.listenerCount("exit")).toBe(before);
	});

	test("without a driver factory the open fails as DRIVER", async () => {
		// another test file in this process may have imported the preload, which installs the real factory
		setDefaultDriverFactory(undefined);
		const session = createSession({ env: envIn(tmp()), exitHook: false });
		await expect(session.driver()).rejects.toMatchObject({ code: "DRIVER" });
	});
});

function recordingAttempt(): { attempt: AttemptContext; events: TraceEvent[]; flushes: () => number } {
	const events: TraceEvent[] = [];
	let flushed = 0;
	const trace: TraceWriter = {
		path: "/dev/null",
		write: (event) => void events.push(event),
		flush: () => {
			flushed += 1;
		},
	};
	const attempt: AttemptContext = {
		signal: new AbortController().signal,
		dir: "/dev/null",
		short: "spec",
		trace,
		depth: 0,
		files: new Set(),
		softFailures: [],
	};
	return { attempt, events, flushes: () => flushed };
}

const spansOf = (events: readonly TraceEvent[]) => events.flatMap((e) => (e.type === "span" ? [e] : []));

describe("Session spans", () => {
	const open = () =>
		createSession({
			env: envIn(tmp()),
			exitHook: false,
			driverFactory: async () => ({
				success: true,
				data: scriptedDriver({ screens: [snapshotOf([el("button", { id: "go" })])] }),
			}),
		});

	test("driver calls inside an attempt are driver.* spans in that attempt's trace", async () => {
		const session = open();
		const first = recordingAttempt();
		const second = recordingAttempt();
		const driver = await session.driver();
		session.enterAttempt(first.attempt);
		await driver.snapshot();
		await driver.tap({ x: 1, y: 1 });
		session.leaveAttempt();
		session.enterAttempt(second.attempt);
		await driver.snapshot();
		expect(spansOf(first.events).map((s) => s.op)).toEqual(["driver.snapshot", "driver.tap"]);
		expect(spansOf(second.events).map((s) => s.op)).toEqual(["driver.snapshot"]);
	});

	test("the driver offers the observation cache: a read it serves from memory writes no snapshot span, an input ends it", async () => {
		const session = open();
		const { attempt, events } = recordingAttempt();
		const driver = await session.driver();
		expect(canObserve(driver)).toBe(true);
		if (!canObserve(driver)) return;
		session.enterAttempt(attempt);
		await driver.observe({ reuse: true });
		await driver.observe({ reuse: true });
		await driver.tap({ x: 1, y: 1 });
		await driver.observe({ reuse: true });
		expect(spansOf(events).map((s) => s.op)).toEqual(["driver.snapshot", "driver.tap", "driver.snapshot"]);
	});

	test("driver calls outside an attempt write nothing and still work", async () => {
		const session = open();
		const driver = await session.driver();
		expect((await driver.snapshot()).success).toBe(true);
	});

	test("peekDriver returns the traced driver too (failure capture goes through it)", async () => {
		const session = open();
		const { attempt, events } = recordingAttempt();
		await session.driver();
		session.enterAttempt(attempt);
		await session.peekDriver()?.snapshot();
		expect(spansOf(events)).toHaveLength(1);
	});

	test("session.span times a call into the running attempt's trace", async () => {
		const session = open();
		const { attempt, events } = recordingAttempt();
		session.enterAttempt(attempt);
		const value = await session.span("device.settle", async () => "done", { detail: () => ({ via: "stream" }) });
		expect(value).toBe("done");
		expect(spansOf(events)[0]).toMatchObject({ op: "device.settle", ok: true, detail: { via: "stream" } });
	});

	test("session.span outside an attempt just runs the call", async () => {
		const session = open();
		expect(await session.span("device.home", async () => 7)).toBe(7);
	});

	test("a span's driver calls nest inside it: both are written, the inner one first", async () => {
		const session = open();
		const { attempt, events } = recordingAttempt();
		const driver = await session.driver();
		session.enterAttempt(attempt);
		await session.span("device.snapshot", async () => driver.snapshot());
		expect(spansOf(events).map((s) => s.op)).toEqual(["driver.snapshot", "device.snapshot"]);
	});
});

describe("attempt slot", () => {
	test("leaveAttempt(ctx) and enterAttempt(next, replacing) never touch another attempt's slot", () => {
		const session = createSession({ env: envIn(tmp()), exitHook: false });
		const old = recordingAttempt().attempt;
		const next = recordingAttempt().attempt;
		session.enterAttempt(next);
		session.enterAttempt({ ...old, depth: 0 }, old);
		session.leaveAttempt(old);
		expect(session.attempt).toBe(next);
		const cleanup = { ...next, depth: 0 };
		session.enterAttempt(cleanup, next);
		expect(session.attempt).toBe(cleanup);
		session.leaveAttempt(cleanup);
		expect(session.attempt).toBeUndefined();
		session.enterAttempt(next);
		session.leaveAttempt();
		expect(session.attempt).toBeUndefined();
	});

	test("attemptSession follows its own binding, not the running attempt", async () => {
		const session = createSession({ env: envIn(tmp()), exitHook: false });
		const own = recordingAttempt();
		const other = recordingAttempt();
		let binding: AttemptBinding = { context: own.attempt, finished: false };
		const bound = attemptSession(session, () => binding);
		session.enterAttempt(other.attempt);
		await bound.step("locator", "tap", async () => undefined);
		await bound.span("device.home", async () => undefined);
		expect(bound.signal).toBe(own.attempt.signal);
		expect(bound.attempt).toBe(own.attempt);
		expect(own.events.map((e) => e.type)).toEqual(["step-start", "step-end", "span"]);
		expect(other.events).toEqual([]);

		binding = {
			context: { ...own.attempt, signal: AbortSignal.abort(new E2eError("SESSION", "attempt finished")) },
			finished: true,
		};
		await expect(bound.step("locator", "tap", async () => undefined)).rejects.toMatchObject({ code: "SESSION" });
		expect(bound.signal.aborted).toBe(true);
		expect(bound.attempt).toBeUndefined();
		expect(bound.trace).toBeUndefined();
		expect(await bound.span("device.home", async () => 1)).toBe(1);
		expect(own.events).toHaveLength(3);
		expect(other.events).toEqual([]);
	});
});

describe("getSession", () => {
	test("is a process-wide singleton on globalThis", async () => {
		const f = factory();
		const first = getSession({ env: envIn(tmp()), driverFactory: f.open, exitHook: false });
		expect(getSession()).toBe(first);
		const holder = globalThis as Record<symbol, unknown>;
		expect(holder[Symbol.for("@delacour/warden-e2e/session")]).toBe(first);
	});

	test("close() forgets the singleton", async () => {
		const first = getSession({ env: envIn(tmp()), driverFactory: factory().open, exitHook: false });
		await first.close();
		const second = getSession({ env: envIn(tmp()), driverFactory: factory().open, exitHook: false });
		expect(second).not.toBe(first);
	});

	test("without env and without WARDEN_UDID it throws SESSION", () => {
		const saved = process.env.WARDEN_UDID;
		delete process.env.WARDEN_UDID;
		try {
			expect(() => getSession()).toThrow(E2eError);
		} finally {
			if (saved !== undefined) process.env.WARDEN_UDID = saved;
		}
	});
});

describe("devtoolsTarget", () => {
	test("pins the inspector page to the leased device when it has a name", () => {
		expect(devtoolsTarget({ ...envIn("/o"), deviceName: "warden-iphone-17-5" })).toEqual({
			appId: "com.acme.app",
			deviceName: "warden-iphone-17-5",
		});
	});

	test("without a device name only the app id picks the page", () => {
		expect(devtoolsTarget(envIn("/o"))).toEqual({ appId: "com.acme.app" });
	});
});
