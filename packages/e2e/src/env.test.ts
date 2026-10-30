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

	test("WARDEN_AFTER_REBOOT is a JSON argv; a bad value is reported by name", () => {
		expect(read({ ...base, WARDEN_AFTER_REBOOT: '["warden","arrange","--open","{udid}"]' })?.afterReboot).toEqual([
			"warden",
			"arrange",
			"--open",
			"{udid}",
		]);
		expect(read(base)?.afterReboot).toBeUndefined();
		const bad = readEnv({ ...base, WARDEN_AFTER_REBOOT: "warden arrange" });
		expect(bad.success).toBe(false);
		expect(bad.success ? "" : bad.error).toContain("WARDEN_AFTER_REBOOT");
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
			WARDEN_E2E_SPECS_DIR: "/app/e2e",
			WARDEN_HELPER_DIR: "/h",
			WARDEN_SIMD: "/h/warden-simd",
			WARDEN_SIMD_SOCKET: "/s.sock",
			WARDEN_IOS_RUNNER_SOCKET: "/r.sock",
			WARDEN_HEADLESS: "1",
			WARDEN_LOG_TIMESTAMPS: "true",
			WARDEN_WORKER: "w1",
			WARDEN_DEVICE_NAME: "warden-iphone-17-5",
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
			specsDir: "/app/e2e",
			helperDir: "/h",
			simd: "/h/warden-simd",
			simdSocket: "/s.sock",
			iosRunnerSocket: "/r.sock",
			logTimestamps: true,
			deviceName: "warden-iphone-17-5",
		});
	});

	test("WARDEN_DEVICE_KIND=physical and the runner restart argv are read; anything else is rejected", () => {
		const env = readEnv({
			...base,
			WARDEN_DEVICE_KIND: "physical",
			WARDEN_IOS_RUNNER_RESTART: JSON.stringify(["warden", "__ios-runner-restart", "--udid", "{udid}"]),
		});
		expect(env.success && env.data).toMatchObject({
			deviceKind: "physical",
			iosRunnerRestart: ["warden", "__ios-runner-restart", "--udid", "{udid}"],
		});
		expect(readEnv({ ...base, WARDEN_DEVICE_KIND: "emulator" }).success).toBe(false);
		const plain = readEnv(base);
		expect(plain.success && plain.data?.deviceKind).toBeUndefined();
	});

	test("WARDEN_HEADLESS and WARDEN_WORKER are for the spec's own tools: never validated, never parsed", () => {
		const result = readEnv({ ...base, WARDEN_HEADLESS: "maybe", WARDEN_WORKER: "w1" });
		expect(result.success).toBe(true);
		if (!result.success || result.data === undefined) return;
		expect("headless" in result.data).toBe(false);
		expect("worker" in result.data).toBe(false);
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
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		const names = result.error.split("\n").map((line) => line.split(":")[0]);
		expect(names).toEqual(["WARDEN_PLATFORM", "WARDEN_LAUNCH_ARGS", "WARDEN_E2E_TIMEOUT"]);
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

describe("WARDEN_VERSION", () => {
	test("is read as wardenVersion, absent otherwise", () => {
		expect(readEnv({ ...base, WARDEN_VERSION: "0.3.0" })).toMatchObject({
			success: true,
			data: { wardenVersion: "0.3.0" },
		});
		const plain = readEnv(base);
		expect(plain.success && plain.data && "wardenVersion" in plain.data).toBe(false);
	});
});

describe("perf env", () => {
	test("WARDEN_BIOMETRICS", () => {
		expect(readEnv({ ...base, WARDEN_BIOMETRICS: "1" })).toMatchObject({ data: { biometrics: true } });
		const off = readEnv({ ...base, WARDEN_BIOMETRICS: "0" });
		expect(off.success && off.data && "biometrics" in off.data).toBe(false);
		expect(readEnv(base)).toMatchObject({ success: true });
	});

	test("WARDEN_BIN, WARDEN_PERF and WARDEN_PERF_BUDGETS", () => {
		const r = readEnv({
			...base,
			WARDEN_BIN: '["bun","/x/cli.ts"]',
			WARDEN_PERF: "react, js",
			WARDEN_PERF_BUDGETS: '{"jankPct":5}',
		});
		expect(r).toMatchObject({
			success: true,
			data: { wardenBin: ["bun", "/x/cli.ts"], perf: ["react", "js"], perfBudgets: '{"jankPct":5}' },
		});
		expect(readEnv({ ...base, WARDEN_BIN: "/bin/warden" })).toMatchObject({ data: { wardenBin: ["/bin/warden"] } });
		const plain = readEnv(base);
		expect(plain.success && plain.data && "perf" in plain.data).toBe(false);
	});

	test("WARDEN_CONDITIONS is the suite's conditions as JSON; a bad value is reported by name", () => {
		const config = { network: "3g", location: { lat: 1, lon: 2 }, clock: "2026-01-01T00:00:00Z" } as const;
		expect(read({ ...base, WARDEN_CONDITIONS: JSON.stringify(config) })?.conditions).toEqual(config);
		const plain = readEnv(base);
		expect(plain.success && plain.data && "conditions" in plain.data).toBe(false);
		for (const bad of ["{", '{"network":"5g"}']) {
			const res = readEnv({ ...base, WARDEN_CONDITIONS: bad });
			expect(res.success).toBe(false);
			expect(res.success ? "" : res.error).toContain("WARDEN_CONDITIONS");
		}
	});
});

describe("lease env", () => {
	test("WARDEN_LEASE_ID is read as leaseId, absent otherwise", () => {
		expect(read({ ...base, WARDEN_LEASE_ID: "lease-9" })?.leaseId).toBe("lease-9");
		expect(read(base)?.leaseId).toBeUndefined();
		expect(read({ ...base, WARDEN_LEASE_ID: "" })?.leaseId).toBeUndefined();
	});

	test("WARDEN_NETPROXY_COMMAND is a JSON argv; a bad value is reported by name", () => {
		expect(read({ ...base, WARDEN_NETPROXY_COMMAND: '["/bin/warden","__netproxy"]' })?.netproxyCommand).toEqual([
			"/bin/warden",
			"__netproxy",
		]);
		expect(read(base)?.netproxyCommand).toBeUndefined();
		const bad = readEnv({ ...base, WARDEN_NETPROXY_COMMAND: "warden __netproxy" });
		expect(bad.success).toBe(false);
		expect(bad.success ? "" : bad.error).toContain("WARDEN_NETPROXY_COMMAND");
		expect(readEnv({ ...base, WARDEN_NETPROXY_COMMAND: "[]" }).success).toBe(false);
	});
});
