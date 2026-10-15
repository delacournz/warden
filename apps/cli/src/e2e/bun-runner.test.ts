import { describe, expect, test } from "bun:test";
import { findBun, findPreload, helperDir, runnerArgv, shardFlows, specEnv } from "./bun-runner";

describe("runnerArgv", () => {
	test("bun test with the preload, a timeout 30 s past the per-test one and the flow files", () => {
		expect(
			runnerArgv({
				bun: "/bin/bun",
				preload: "/p/preload.ts",
				flowPaths: ["/f/a.e2e.ts", "/f/b.e2e.ts"],
				timeoutMs: 120_000,
			})
		).toEqual(["/bin/bun", "test", "--preload", "/p/preload.ts", "--timeout", "150000", "/f/a.e2e.ts", "/f/b.e2e.ts"]);
	});

	test("junitPath adds the junit reporter", () => {
		expect(
			runnerArgv({
				bun: "bun",
				preload: "/p",
				flowPaths: ["/f/a.e2e.ts"],
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
	test("WARDEN_BUN wins, then PATH, else an error naming both", () => {
		const which = (name: string) => (name === "bun" ? "/usr/bin/bun" : null);
		expect(findBun({ WARDEN_BUN: "/opt/bun" }, which)).toEqual({ success: true, data: "/opt/bun" });
		expect(findBun({}, which)).toEqual({ success: true, data: "/usr/bin/bun" });
		expect(findBun({ WARDEN_BUN: "" }, which)).toEqual({ success: true, data: "/usr/bin/bun" });
		expect(findBun({}, () => null)).toEqual({
			success: false,
			error: "bun >= 1.3 is required on PATH (or set WARDEN_BUN)",
		});
	});
});

describe("findPreload", () => {
	test("resolves @delacour/warden-e2e/preload from the suite cwd", () => {
		const seen: string[] = [];
		const found = findPreload("/repo/app", (specifier, from) => {
			seen.push(`${specifier} ${from}`);
			return "/repo/node_modules/@delacour/warden-e2e/src/preload.ts";
		});
		expect(found).toEqual({ success: true, data: "/repo/node_modules/@delacour/warden-e2e/src/preload.ts" });
		expect(seen).toEqual(["@delacour/warden-e2e/preload /repo/app"]);
	});

	test("an unresolvable package says how to install it", () => {
		const found = findPreload("/repo/app", () => {
			throw new Error("Cannot find package");
		});
		expect(found).toEqual({ success: false, error: "bun add -d @delacour/warden-e2e" });
	});
});

describe("shardFlows", () => {
	const flows = ["e", "b", "d", "a", "c"].map((id) => ({ id }));
	const ids = (shards: Array<Array<{ id: string }>>) => shards.map((s) => s.map((f) => f.id));

	test("round-robin by sorted id: flow i goes to shard i % n", () => {
		expect(ids(shardFlows(flows, 2))).toEqual([
			["a", "c", "e"],
			["b", "d"],
		]);
		expect(ids(shardFlows(flows, 3))).toEqual([["a", "d"], ["b", "e"], ["c"]]);
	});

	test("never more shards than flows, never fewer than one", () => {
		expect(shardFlows(flows.slice(0, 2), 5)).toHaveLength(2);
		expect(ids(shardFlows(flows, 1))).toEqual([["a", "b", "c", "d", "e"]]);
		expect(shardFlows(flows, 0)).toHaveLength(1);
		expect(shardFlows([], 3)).toEqual([]);
	});
});

describe("specEnv", () => {
	test("the env contract of one spec process", () => {
		expect(
			specEnv({
				platform: "ios",
				bundleId: "com.x.app",
				launchArgs: ["--initialUrl", "http://127.0.0.1:8081"],
				out: "/b/e2e/0-1",
				timeouts: { timeoutMs: 120_000, actionTimeoutMs: 30_000, assertionTimeoutMs: 5_000 },
				flowsDir: "/repo/flows",
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
			WARDEN_E2E_FLOWS_DIR: "/repo/flows",
			WARDEN_HELPER_DIR: "/bin",
			WARDEN_VERSION: "0.3.0",
		});
	});
});

describe("helperDir", () => {
	test("a compiled binary: the directory of the executable", () => {
		expect(helperDir("/$bunfs/root/warden", "/home/me/.local/bin/warden")).toBe("/home/me/.local/bin");
	});

	test("from source: the helper's build output in the checkout", () => {
		expect(helperDir("/repo/apps/cli/src/cli.ts", "/usr/bin/bun")).toBe("/repo/packages/e2e/native/dist");
	});
});
