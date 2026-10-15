import { describe, expect, test } from "bun:test";
import { installPreload, type PreloadDeps } from "./preload";
import type { Session } from "./session";

function harness(env: Record<string, string | undefined>) {
	const log = {
		timeouts: [] as number[],
		hooks: [] as Array<() => Promise<void>>,
		sessions: [] as unknown[],
		stderr: [] as string[],
		exits: [] as number[],
		closed: 0,
	};
	const session = {
		async close() {
			log.closed += 1;
		},
	} as unknown as Session;
	const deps: PreloadDeps = {
		env,
		setDefaultTimeout: (ms) => log.timeouts.push(ms),
		afterAll: (fn) => log.hooks.push(fn),
		createSession: (opts) => {
			log.sessions.push(opts);
			return session;
		},
		stderr: (text) => log.stderr.push(text),
		exit: (code) => log.exits.push(code),
	};
	return { deps, log };
}

describe("installPreload", () => {
	test("is a no-op without WARDEN_UDID", () => {
		const { deps, log } = harness({});
		installPreload(deps);
		expect(log).toEqual({ timeouts: [], hooks: [], sessions: [], stderr: [], exits: [], closed: 0 });
	});

	test("exits 2 with a clear message on invalid env", () => {
		const { deps, log } = harness({ WARDEN_UDID: "U" });
		installPreload(deps);
		expect(log.exits).toEqual([2]);
		expect(log.stderr.join("")).toContain("WARDEN_BUNDLE_ID: required when WARDEN_UDID is set");
		expect(log.sessions).toHaveLength(0);
		expect(log.timeouts).toHaveLength(0);
	});

	test("under warden: timeout + 30s, eager session, afterAll closes it", async () => {
		const { deps, log } = harness({
			WARDEN_UDID: "U",
			WARDEN_BUNDLE_ID: "com.acme.app",
			WARDEN_E2E_TIMEOUT: "60000",
			WARDEN_E2E_OUT: "/tmp/out",
		});
		installPreload(deps);
		expect(log.timeouts).toEqual([90_000]);
		expect(log.sessions).toHaveLength(1);
		expect(log.sessions[0]).toMatchObject({ env: { udid: "U", out: "/tmp/out", timeoutMs: 60_000 } });
		expect(log.hooks).toHaveLength(1);
		expect(log.closed).toBe(0);
		await log.hooks[0]?.();
		expect(log.closed).toBe(1);
	});
});
