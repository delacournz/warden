import { describe, expect, test } from "bun:test";
import { ENV_NAMES, readEnv } from "./env";

const base = { WARDEN_UDID: "UDID-1", WARDEN_BUNDLE_ID: "com.acme.app" };
const fixedNow = () => new Date("2026-10-15T01:02:03.004Z");

function read(env: Record<string, string | undefined>) {
	const result = readEnv(env, { now: fixedNow });
	if (!result.success) throw new Error(result.error);
	return result.data;
}

describe("readEnv", () => {
	test("no WARDEN_UDID means not under warden", () => {
		expect(readEnv({})).toEqual({ success: true, data: undefined });
		expect(readEnv({ WARDEN_UDID: "", WARDEN_BUNDLE_ID: "x" })).toEqual({ success: true, data: undefined });
	});

	test("defaults", () => {
		expect(read(base)).toEqual({
			udid: "UDID-1",
			platform: "ios",
			bundleId: "com.acme.app",
			launchArgs: [],
			out: ".warden-e2e/2026-10-15T01:02:03.004Z",
			timeoutMs: 120_000,
			actionTimeoutMs: 30_000,
			assertionTimeoutMs: 5_000,
			headless: false,
			logTimestamps: false,
		});
	});

	test("reads every variable", () => {
		const env = read({
			...base,
			WARDEN_PLATFORM: "android",
			WARDEN_APP_PATH: "/b/app.apk",
			WARDEN_METRO_URL: "http://localhost:8081",
			WARDEN_LAUNCH_ARGS: '["--initialUrl","http://x"]',
			WARDEN_E2E_OUT: "/tmp/out",
			WARDEN_E2E_TIMEOUT: "1000",
			WARDEN_E2E_ACTION_TIMEOUT: "2000",
			WARDEN_E2E_ASSERTION_TIMEOUT: "300",
			WARDEN_E2E_FLOWS_DIR: "/app/e2e",
			WARDEN_HELPER_DIR: "/h",
			WARDEN_SIMD: "/h/warden-simd",
			WARDEN_SIMD_SOCKET: "/s.sock",
			WARDEN_HEADLESS: "1",
			WARDEN_LOG_TIMESTAMPS: "true",
			WARDEN_WORKER: "w1",
		});
		expect(env).toEqual({
			udid: "UDID-1",
			platform: "android",
			bundleId: "com.acme.app",
			appPath: "/b/app.apk",
			metroUrl: "http://localhost:8081",
			launchArgs: ["--initialUrl", "http://x"],
			out: "/tmp/out",
			timeoutMs: 1000,
			actionTimeoutMs: 2000,
			assertionTimeoutMs: 300,
			flowsDir: "/app/e2e",
			helperDir: "/h",
			simd: "/h/warden-simd",
			simdSocket: "/s.sock",
			headless: true,
			logTimestamps: true,
			worker: "w1",
		});
	});

	test("empty values count as unset", () => {
		expect(read({ ...base, WARDEN_PLATFORM: "", WARDEN_LAUNCH_ARGS: "", WARDEN_E2E_OUT: "" })?.platform).toBe("ios");
	});

	test("bundle id is required with a udid", () => {
		expect(readEnv({ WARDEN_UDID: "U" })).toEqual({
			success: false,
			error: "WARDEN_BUNDLE_ID: required when WARDEN_UDID is set",
		});
	});

	test("errors name the env variables", () => {
		const result = readEnv({
			...base,
			WARDEN_PLATFORM: "windows",
			WARDEN_LAUNCH_ARGS: "not json",
			WARDEN_E2E_TIMEOUT: "soon",
			WARDEN_HEADLESS: "maybe",
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		const names = result.error.split("\n").map((line) => line.split(":")[0]);
		expect(names).toEqual(["WARDEN_PLATFORM", "WARDEN_LAUNCH_ARGS", "WARDEN_E2E_TIMEOUT", "WARDEN_HEADLESS"]);
		expect(result.error).toContain("WARDEN_LAUNCH_ARGS: must be a JSON array of strings");
	});

	test("launch args must be strings", () => {
		expect(readEnv({ ...base, WARDEN_LAUNCH_ARGS: "[1]" }).success).toBe(false);
		expect(readEnv({ ...base, WARDEN_LAUNCH_ARGS: '{"a":1}' }).success).toBe(false);
	});

	test("timeouts must be positive", () => {
		expect(readEnv({ ...base, WARDEN_E2E_TIMEOUT: "0" }).success).toBe(false);
		expect(readEnv({ ...base, WARDEN_E2E_ACTION_TIMEOUT: "-5" }).success).toBe(false);
	});
});

describe("ENV_NAMES", () => {
	test("all names are WARDEN_-prefixed and unique", () => {
		const names = Object.values(ENV_NAMES);
		expect(new Set(names).size).toBe(names.length);
		for (const name of names) expect(name.startsWith("WARDEN_")).toBe(true);
	});
});
