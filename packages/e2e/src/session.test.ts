import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver, DriverResult } from "./driver/driver.types";
import type { E2eEnv } from "./env";
import { E2eError } from "./errors";
import { createSession, devtoolsTarget, getSession, resetSession } from "./session";

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
	headless: false,
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
		expect(a).toBe(f.fake.driver);
		expect(b).toBe(a);
		expect(c).toBe(a);
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
		expect(await session.driver()).toBe(fake.driver);
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
		const session = createSession({ env: envIn(tmp()), exitHook: false });
		await expect(session.driver()).rejects.toMatchObject({ code: "DRIVER" });
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
