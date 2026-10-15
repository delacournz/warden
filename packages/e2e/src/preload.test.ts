import { afterAll, describe, expect, test } from "bun:test";
import { installPreload, isCi, type PreloadDeps, versionMismatch } from "./preload";
import { type Session, setDefaultDriverFactory, setDefaultFixtureFactory } from "./session";

// importing ./preload installs the real driver + fixture factories process-wide; later test files start clean
afterAll(() => {
	setDefaultDriverFactory(undefined);
	setDefaultFixtureFactory(undefined);
});

function harness(env: Record<string, string | undefined>, onlySeen = false) {
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
		version: "0.3.0",
		onlySeen: () => onlySeen,
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

	test("a collected .only fails the run under CI, after the session is closed", async () => {
		const env = { WARDEN_UDID: "U", WARDEN_BUNDLE_ID: "b", CI: "1" };
		const { deps, log } = harness(env, true);
		installPreload(deps);
		await expect(log.hooks[0]?.()).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
		expect(log.closed).toBe(1);
	});

	test(".only is fine outside CI, and CI without .only is fine", async () => {
		const local = harness({ WARDEN_UDID: "U", WARDEN_BUNDLE_ID: "b" }, true);
		installPreload(local.deps);
		await local.log.hooks[0]?.();
		const ci = harness({ WARDEN_UDID: "U", WARDEN_BUNDLE_ID: "b", CI: "true" }, false);
		installPreload(ci.deps);
		await ci.log.hooks[0]?.();
	});
});

describe("version handshake", () => {
	const under = { WARDEN_UDID: "U", WARDEN_BUNDLE_ID: "b" };

	test("a different warden version is refused: message on stderr, exit 2, nothing installed", () => {
		const { deps, log } = harness({ ...under, WARDEN_VERSION: "0.4.0" });
		installPreload(deps);
		expect(log.stderr.join("")).toContain("@delacour/warden-e2e 0.3.0 does not match warden 0.4.0");
		expect(log.stderr.join("")).toContain("bun add -d @delacour/warden-e2e@0.4.0");
		expect(log.exits).toEqual([2]);
		expect(log.sessions).toHaveLength(0);
		expect(log.timeouts).toHaveLength(0);
		expect(log.hooks).toHaveLength(0);
	});

	test("same version, or no WARDEN_VERSION (by-hand run), or not under warden: silent", () => {
		for (const env of [{ ...under, WARDEN_VERSION: "0.3.0" }, under, { WARDEN_VERSION: "9.9.9" }]) {
			const { deps, log } = harness(env);
			installPreload(deps);
			expect(log.stderr).toEqual([]);
		}
	});

	test("versionMismatch", () => {
		expect(versionMismatch(undefined, "1.0.0")).toBeUndefined();
		expect(versionMismatch("1.0.0", "1.0.0")).toBeUndefined();
		expect(versionMismatch("1.1.0", "1.0.0")).toContain("1.1.0");
		expect(versionMismatch("1.1.0", "0.0.0-workspace")).toBeUndefined();
	});
});

describe("isCi", () => {
	test("anything but unset, empty, 0 and false", () => {
		expect(isCi({})).toBe(false);
		expect(isCi({ CI: "" })).toBe(false);
		expect(isCi({ CI: "0" })).toBe(false);
		expect(isCi({ CI: "false" })).toBe(false);
		expect(isCi({ CI: "1" })).toBe(true);
		expect(isCi({ CI: "true" })).toBe(true);
	});
});
