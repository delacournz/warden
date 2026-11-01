import { describe, expect, test } from "bun:test";
import { envReader } from "@delacour/warden-e2e/env";
import { bunRunner, NETPROXY_SUBCOMMAND } from "./bun-runner";

describe("runnerArgv", () => {
	test("bun test with the preload, a timeout 30 s past the per-test one and the spec files", () => {
		expect(
			bunRunner.runnerArgv({
				bun: "/bin/bun",
				preload: "/p/preload.ts",
				specPaths: ["/f/a.e2e.ts", "/f/b.e2e.ts"],
				timeoutMs: 120_000,
			})
		).toEqual(["/bin/bun", "test", "--preload", "/p/preload.ts", "--timeout", "150000", "/f/a.e2e.ts", "/f/b.e2e.ts"]);
	});

	test("junitPath adds the junit reporter", () => {
		expect(
			bunRunner.runnerArgv({
				bun: "bun",
				preload: "/p",
				specPaths: ["/f/a.e2e.ts"],
				timeoutMs: 1_000,
				junitPath: "/o/junit.xml",
			})
		).toEqual([
			"bun",
			"test",
			"--preload",
			"/p",
			"--timeout",
			"31000",
			"--reporter=junit",
			"--reporter-outfile",
			"/o/junit.xml",
			"/f/a.e2e.ts",
		]);
	});
});

describe("findBun", () => {
	test("WARDEN_BUN wins, else warden's own executable runs as bun: no bun install needed", () => {
		expect(bunRunner.findBun({ WARDEN_BUN: "/opt/bun" }, "/usr/local/bin/warden")).toBe("/opt/bun");
		expect(bunRunner.findBun({}, "/usr/local/bin/warden")).toBe("/usr/local/bin/warden");
		expect(bunRunner.findBun({ WARDEN_BUN: "" }, "/usr/local/bin/warden")).toBe("/usr/local/bin/warden");
	});
});

describe("shardSpecs", () => {
	const specs = ["e", "b", "d", "a", "c"].map((id) => ({ id }));
	const ids = (shards: Array<Array<{ id: string }>>) => shards.map((s) => s.map((f) => f.id));

	test("round-robin by sorted id: spec i goes to shard i % n", () => {
		expect(ids(bunRunner.shardSpecs(specs, 2))).toEqual([
			["a", "c", "e"],
			["b", "d"],
		]);
		expect(ids(bunRunner.shardSpecs(specs, 3))).toEqual([["a", "d"], ["b", "e"], ["c"]]);
	});

	test("never more shards than specs, never fewer than one", () => {
		expect(bunRunner.shardSpecs(specs.slice(0, 2), 5)).toHaveLength(2);
		expect(ids(bunRunner.shardSpecs(specs, 1))).toEqual([["a", "b", "c", "d", "e"]]);
		expect(bunRunner.shardSpecs(specs, 0)).toHaveLength(1);
		expect(bunRunner.shardSpecs([], 3)).toEqual([]);
	});
});

describe("specEnv", () => {
	test("the env contract of one spec process", () => {
		expect(
			bunRunner.specEnv({
				platform: "ios",
				bundleId: "com.x.app",
				launchArgs: ["--initialUrl", "http://127.0.0.1:8081"],
				out: "/b/e2e/0-1",
				timeouts: { timeoutMs: 120_000, actionTimeoutMs: 30_000, assertionTimeoutMs: 5_000 },
				specsDir: "/repo/specs",
				helperDir: "/bin",
				version: "0.3.0",
			})
		).toEqual({
			WARDEN_PLATFORM: "ios",
			WARDEN_BUNDLE_ID: "com.x.app",
			WARDEN_LAUNCH_ARGS: '["--initialUrl","http://127.0.0.1:8081"]',
			WARDEN_E2E_OUT: "/b/e2e/0-1",
			WARDEN_E2E_TIMEOUT: "120000",
			WARDEN_E2E_ACTION_TIMEOUT: "30000",
			WARDEN_E2E_ASSERTION_TIMEOUT: "5000",
			WARDEN_E2E_SPECS_DIR: "/repo/specs",
			WARDEN_HELPER_DIR: "/bin",
			WARDEN_VERSION: "0.3.0",
			BUN_BE_BUN: "1",
		});
	});
});

describe("helperDir", () => {
	test("a compiled binary: the directory of the executable", () => {
		expect(bunRunner.helperDir("/$bunfs/root/warden", "/home/me/.local/bin/warden")).toBe("/home/me/.local/bin");
	});

	test("from source: the helper's build output in the checkout", () => {
		expect(bunRunner.helperDir("/repo/apps/cli/src/cli.ts", "/usr/bin/bun")).toBe(
			"/repo/packages/driver-ios/native/dist"
		);
	});
});

describe("specEnv perf", () => {
	const base = {
		platform: "ios" as const,
		bundleId: "com.x.app",
		launchArgs: [],
		out: "/o",
		timeouts: { timeoutMs: 1, actionTimeoutMs: 1, assertionTimeoutMs: 1 },
		specsDir: "/f",
		helperDir: "/h",
		version: "1",
	};

	test("WARDEN_BIN, WARDEN_PERF and the budgets", () => {
		const env = bunRunner.specEnv({
			...base,
			bin: ["/bin/warden"],
			perf: ["react", "js"],
			perfBudgets: { jankPct: 5 },
		});
		expect(env.WARDEN_BIN).toBe('["/bin/warden"]');
		expect(env.WARDEN_PERF).toBe("react,js");
		expect(env.WARDEN_PERF_BUDGETS).toBe('{"jankPct":5}');
	});

	test("WARDEN_BIOMETRICS only for a biometrics suite", () => {
		expect(bunRunner.specEnv({ ...base, biometrics: true }).WARDEN_BIOMETRICS).toBe("1");
		expect("WARDEN_BIOMETRICS" in bunRunner.specEnv({ ...base, biometrics: false })).toBe(false);
	});

	test("absent unless asked for; empty budgets are not exported", () => {
		const env = bunRunner.specEnv({ ...base, perfBudgets: {} });
		expect(Object.keys(env).filter((k) => k.includes("PERF") || k === "WARDEN_BIN")).toEqual([]);
	});
});

describe("specEnv conditions", () => {
	const base = {
		platform: "ios" as const,
		bundleId: "com.x.app",
		launchArgs: [],
		out: "/o",
		timeouts: { timeoutMs: 1, actionTimeoutMs: 1, assertionTimeoutMs: 1 },
		specsDir: "/f",
		helperDir: "/h",
		version: "1",
	};

	test("WARDEN_CONDITIONS is the suite's conditions as JSON and the spec process reads it back", () => {
		const conditions = { network: "3g", location: { lat: 1, lon: 2 } } as const;
		const env = bunRunner.specEnv({ ...base, conditions });
		expect(env.WARDEN_CONDITIONS).toBe(JSON.stringify(conditions));
		const read = envReader.read({ WARDEN_UDID: "u", WARDEN_BUNDLE_ID: "b", ...env });
		expect(read.success && read.data?.conditions).toEqual(conditions);
	});

	test("absent when the suite sets none", () => {
		expect("WARDEN_CONDITIONS" in bunRunner.specEnv(base)).toBe(false);
		expect("WARDEN_CONDITIONS" in bunRunner.specEnv({ ...base, conditions: {} })).toBe(false);
	});
});

describe("specEnv netproxy command", () => {
	const base = {
		platform: "android" as const,
		bundleId: "com.x.app",
		launchArgs: [],
		out: "/o",
		timeouts: { timeoutMs: 1, actionTimeoutMs: 1, assertionTimeoutMs: 1 },
		specsDir: "/f",
		helperDir: "/h",
		version: "1",
	};

	test("a compiled warden hands specs its hidden subcommand as JSON argv, and the spec process reads it back", () => {
		const env = bunRunner.specEnv({ ...base, netproxyCommand: ["/bin/warden", NETPROXY_SUBCOMMAND] });
		expect(env.WARDEN_NETPROXY_COMMAND).toBe('["/bin/warden","__netproxy"]');
		const read = envReader.read({ WARDEN_UDID: "u", WARDEN_BUNDLE_ID: "b", WARDEN_LEASE_ID: "L1", ...env });
		expect(read.success && read.data).toMatchObject({ leaseId: "L1", netproxyCommand: ["/bin/warden", "__netproxy"] });
	});

	test("absent from source", () => {
		expect("WARDEN_NETPROXY_COMMAND" in bunRunner.specEnv(base)).toBe(false);
	});
});

describe("parsePerfFlag", () => {
	test("off, bare, list, unknown", () => {
		expect(bunRunner.parsePerfFlag(undefined)).toEqual({ success: true, data: undefined });
		expect(bunRunner.parsePerfFlag(true)).toEqual({ success: true, data: [] });
		expect(bunRunner.parsePerfFlag("react, js")).toEqual({ success: true, data: ["react", "js"] });
		expect(bunRunner.parsePerfFlag("all")).toEqual({ success: true, data: ["all"] });
		expect(bunRunner.parsePerfFlag("bogus").success).toBe(false);
	});
});
