import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "@delacour/warden-types/result";
import { startFakeMetro } from "./devtools/devtools.testing";
import { devtoolsErr } from "./devtools/devtools.types";
import { stubFacet } from "./devtools/facet.testing";
import type { E2eEnv } from "./env";
import { createSession } from "./session";

const dirs: string[] = [];
const tmp = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "wdn-session-dt-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const envIn = (extra: Partial<E2eEnv> = {}): E2eEnv => ({
	udid: "U1",
	platform: "ios",
	bundleId: "com.acme.app",
	launchArgs: [],
	out: tmp(),
	timeoutMs: 120_000,
	actionTimeoutMs: 30_000,
	assertionTimeoutMs: 5_000,
	headless: false,
	logTimestamps: false,
	...extra,
});

describe("Session devtools", () => {
	test("without a Metro URL (release build) it is devtools_unavailable and nothing is opened", async () => {
		let opens = 0;
		const session = createSession({
			env: envIn(),
			exitHook: false,
			devtools: async () => {
				opens += 1;
				return ok(stubFacet().facet);
			},
		});
		const result = await session.devtools();
		expect(!result.success && result.error.code).toBe("devtools_unavailable");
		expect(opens).toBe(0);
		expect(session.peekDevtools()).toBeUndefined();
	});

	test("opens on the first call, once and shared, even concurrently", async () => {
		const stub = stubFacet();
		const seen: E2eEnv[] = [];
		const session = createSession({
			env: envIn({ metroUrl: "http://127.0.0.1:8081" }),
			exitHook: false,
			devtools: async (env) => {
				seen.push(env);
				return ok(stub.facet);
			},
		});
		expect(session.peekDevtools()).toBeUndefined();
		const [a, b] = await Promise.all([session.devtools(), session.devtools()]);
		expect(a.success && a.data).toBe(stub.facet);
		expect(b.success && b.data).toBe(stub.facet);
		expect(seen).toHaveLength(1);
		expect(session.peekDevtools()).toBe(stub.facet);
	});

	test("a failed open is returned and retried on the next call", async () => {
		const stub = stubFacet();
		let attempts = 0;
		const session = createSession({
			env: envIn({ metroUrl: "http://127.0.0.1:8081" }),
			exitHook: false,
			devtools: async () => {
				attempts += 1;
				return attempts === 1 ? devtoolsErr("devtools_unavailable", "Metro is down") : ok(stub.facet);
			},
		});
		const first = await session.devtools();
		expect(!first.success && first.error.message).toBe("Metro is down");
		expect(session.peekDevtools()).toBeUndefined();
		const second = await session.devtools();
		expect(second.success).toBe(true);
	});

	test("a facet that emitted lost is dropped: peek forgets it and the next call opens a fresh one", async () => {
		const first = stubFacet();
		const second = stubFacet();
		const lostHandlers: ((error: { code: "devtools_unavailable"; message: string }) => void)[] = [];
		const lostable = {
			...first.facet,
			on: ((event: string, handler: (error: { code: "devtools_unavailable"; message: string }) => void) => {
				if (event === "lost") lostHandlers.push(handler);
				return () => undefined;
			}) as typeof first.facet.on,
		};
		const opened = [lostable, second.facet];
		const session = createSession({
			env: envIn({ metroUrl: "http://127.0.0.1:8081" }),
			exitHook: false,
			devtools: async () => {
				const next = opened.shift();
				return next === undefined ? devtoolsErr("devtools_unavailable", "no more") : ok(next);
			},
		});
		const a = await session.devtools();
		expect(a.success && a.data).toBe(lostable);
		expect(lostHandlers).toHaveLength(1);
		for (const handler of lostHandlers) handler({ code: "devtools_unavailable", message: "gone" });
		expect(session.peekDevtools()).toBeUndefined();
		expect(first.closes()).toBe(1);
		const b = await session.devtools();
		expect(b.success && b.data).toBe(second.facet);
		expect(session.peekDevtools()).toBe(second.facet);
		await session.close();
		expect(second.closes()).toBe(1);
		expect(first.closes()).toBe(1);
	});

	test("close() closes an opened facet once", async () => {
		const stub = stubFacet();
		const session = createSession({
			env: envIn({ metroUrl: "http://127.0.0.1:8081" }),
			exitHook: false,
			devtools: async () => ok(stub.facet),
		});
		await session.devtools();
		await Promise.all([session.close(), session.close()]);
		expect(stub.closes()).toBe(1);
	});

	test("close() never opens devtools", async () => {
		let opens = 0;
		const session = createSession({
			env: envIn({ metroUrl: "http://127.0.0.1:8081" }),
			exitHook: false,
			devtools: async () => {
				opens += 1;
				return ok(stubFacet().facet);
			},
		});
		await session.close();
		expect(opens).toBe(0);
	});

	test("the default opener connects to a real (fake) Metro", async () => {
		const fake = startFakeMetro();
		try {
			const session = createSession({ env: envIn({ metroUrl: fake.url }), exitHook: false });
			const result = await session.devtools();
			expect(result.success).toBe(true);
			if (result.success) expect(result.data.target.id).toBeDefined();
			await session.close();
		} finally {
			await fake.stop();
		}
	});
});
