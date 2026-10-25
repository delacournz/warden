import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { findSuite } from "@delacour/warden-core/affected/affected";
import { makeSuiteRepo } from "@delacour/warden-core/affected/fixture.testing";
import { bunExec } from "@delacour/warden-core/exec";
import { ok } from "@delacour/warden-types/result";
import type { ProcHandle, SpawnOptions } from "../commands/batch";
import { type TestContext, testContext } from "../testing";
import { runVerify, type VerifyDeps } from "./authoring-verify";

let cleanup: (() => void)[] = [];
afterEach(() => {
	for (const fn of cleanup) fn();
	cleanup = [];
});

const RESULT = (file: string, status: string) =>
	`${JSON.stringify({
		file,
		title: ["sign in"],
		status,
		durationMs: 5,
		startedAt: 1,
		...(status === "failed"
			? { error: { message: "boom" }, artifacts: { dir: "/out/attempt-1", files: ["screen-at-failure.txt"] } }
			: {}),
		device: { udid: "U1", platform: "ios" },
	})}\n`;

async function setup(code: number, results: string | undefined) {
	const repo = await makeSuiteRepo();
	cleanup.push(() => rmSync(repo.dir, { recursive: true, force: true }));
	const ctx: TestContext = testContext([], { exec: bunExec });
	cleanup.push(ctx.cleanup);
	ctx.cwd = repo.dir;
	const suite = await findSuite(ctx.exec, repo.dir, undefined, ctx.git, ctx.env);
	if (!suite.success) throw new Error(suite.error.message);
	const spawned: { argv: string[]; opts: SpawnOptions }[] = [];
	const timers: number[] = [];
	const deps: VerifyDeps = {
		which: () => "/bin/bun",
		resolveModule: () => "/repo/node_modules/@delacour/warden-e2e/preload.ts",
		e2eVersion: () => undefined,
		bundledE2e: async () => ok("/bundled/preload.mjs"),
		helperDir: () => "/helper",
		mkdir: async () => undefined,
		readFile: async () => {
			if (results === undefined) throw new Error("ENOENT");
			return results;
		},
		after: (ms) => {
			timers.push(ms);
			return () => undefined;
		},
		spawn: (argv, opts): ProcHandle => {
			spawned.push({ argv, opts });
			return { exited: Promise.resolve(code), kill: () => undefined };
		},
	};
	return { ctx, deps, suite: suite.data, spawned, timers };
}

const input = (suite: Awaited<ReturnType<typeof setup>>["suite"]) => ({
	udid: "U1",
	platform: "ios" as const,
	deviceName: "sim",
	specPath: join(suite.configDir, "specs", "sign-in.e2e.ts"),
	suite,
	outDir: "/out",
	metroUrl: "http://localhost:8081",
	simdSocket: "/simd.sock",
});

test("runs the spec with the argv and env a warden e2e spec process gets, plus the device identity", async () => {
	const { ctx, deps, suite, spawned, timers } = await setup(0, RESULT("/s", "passed"));
	const ran = await runVerify(ctx, deps, input(suite));
	expect(ran).toMatchObject({ success: true, data: { passed: true, exitCode: 0, results: "/out/results.jsonl" } });
	const [proc] = spawned;
	expect(proc?.argv.slice(0, 4)).toEqual([
		"/bin/bun",
		"test",
		"--preload",
		"/repo/node_modules/@delacour/warden-e2e/preload.ts",
	]);
	expect(proc?.argv.at(-1)).toBe(join(suite.configDir, "specs", "sign-in.e2e.ts"));
	expect(proc?.opts.env).toMatchObject({
		WARDEN_UDID: "U1",
		WARDEN_DEVICE_NAME: "sim",
		WARDEN_PLATFORM: "ios",
		WARDEN_BUNDLE_ID: "com.x",
		WARDEN_E2E_OUT: "/out",
		WARDEN_METRO_URL: "http://localhost:8081",
		WARDEN_SIMD_SOCKET: "/simd.sock",
		WARDEN_HELPER_DIR: "/helper",
	});
	expect(proc?.opts.env.WARDEN_LAUNCH_ARGS).toContain("--initialUrl");
	expect(proc?.opts.cwd).toBe(suite.cwd);
	expect(timers).toEqual([suite.config.jobTimeoutMs]);
});

test("a failed test reports its error and evidence files", async () => {
	const { ctx, deps, suite } = await setup(1, RESULT("/s", "failed"));
	const ran = await runVerify(ctx, deps, input(suite));
	expect(ran).toMatchObject({
		success: true,
		data: {
			passed: false,
			exitCode: 1,
			tests: [{ status: "failed", error: "boom", evidence: ["/out/attempt-1/screen-at-failure.txt"] }],
		},
	});
});

test("exit 0 with no results is not a pass", async () => {
	const { ctx, deps, suite } = await setup(0, undefined);
	const ran = await runVerify(ctx, deps, input(suite));
	expect(ran).toMatchObject({ success: true, data: { passed: false, tests: [] } });
});

test("a missing bun is an error before anything is spawned", async () => {
	const { ctx, deps, suite, spawned } = await setup(0, undefined);
	const ran = await runVerify(ctx, { ...deps, which: () => null }, input(suite));
	expect(ran.success).toBe(false);
	expect(spawned).toEqual([]);
});
